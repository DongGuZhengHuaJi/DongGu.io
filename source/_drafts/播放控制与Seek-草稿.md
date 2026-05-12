---
title: 播放器开发--播放控制与Seek（草稿）
date: ~
categories: [音视频学习]
tags:
  - C++
  - Qt6
  - FFmpeg
  - OpenGL
draft: true
---

> 以下内容来自 A-V同步(2) 文章，暂时移至此处。待写完 YUV 渲染篇后再发。

## pause、resume以及seek逻辑

### `pause()`函数

```C++
void PlayerController::pause() {
    if (!_isPlaying.load() || _paused.load()) return;
    _paused.store(true);
    _clock->pause();
    if (_hasAudio) _audioOutput.pause();
    emit pausedChanged();
}
```

`pause()` 和 `resume()` 都注册了 `Q_INVOKABLE`，由 QML 界面按钮触发。

`PlayerController::pause()` 做了三件事：

1. `_clock->pause()` — 冻结时钟（`getTime()` 不再外推 wall-clock 流逝的时间）
2. `_audioOutput.pause()` — 置位 `_pause` 原子变量，AudioOutput 消费线程检测到后进入睡眠循环
3. `_paused = true` — 阻止重复 pause 调用，通知 UI 状态变更

> **注意**：pause 并**不停止解码线程**。解码器继续产出帧，直到 FrameQueue 满后阻塞在 `push()`。这样 resume 后数据已经在队列里，不需要等待解码冷启动。


### `resume()`函数

```C++
void PlayerController::resume() {
    if (!_paused.load()) return;
    if (_hasAudio) _audioOutput.resume();
    _clock->resume();
    _paused.store(false);
    emit pausedChanged();
}
```

resume 按相反顺序恢复：先唤醒 AudioOutput（清除 `_pause`，消费线程退出睡眠循环），再恢复 Clock 走时，最后更新状态。

### AudioOutput 的 pause/resume 内部机制

回顾 `consumeLoop` 中的相关代码：

```C++
// 检测 _pause 状态变化，由消费者线程独占调用 QAudioSink::suspend/resume
bool nowPaused = _pause.load();
if (nowPaused != wasPaused) {
    wasPaused = nowPaused;
    if (nowPaused && _audioSink) {
        _audioSink->suspend();          // 暂停声卡硬件
    } else if (!nowPaused && _audioSink) {
        _audioSink->resume();           // 恢复声卡硬件
    }
}

if (nowPaused) {
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
    continue;                           // 跳过帧消费和时钟更新
}
```

关键在于：暂停后消费循环只是以 10ms 间隔空转，既不从队列取帧、也不写入声卡、更不更新时钟。声卡本身也通过 `suspend()/resume()` 在硬件层面暂停/恢复，避免播放残余缓冲数据。

而视频侧——`VideoFboRenderer::synchronize()` 每帧仍然被 Qt 回调，但由于 Clock 已冻结，`diff = framePts - clockTime` 始终为正值（帧领先），每次都会走"等待"分支返回。画面停留在最后一帧，直到 resume。

### `seek()`函数

```C++
void PlayerController::seek(double seconds) {
    // 防止长按键触发的连续 seek 重入导致崩溃
    if (_seeking.exchange(true)) return;

    double dur = _demuxer.getDuration();
    if (seconds < 0.0) seconds = 0.0;
    if (seconds > dur) seconds = dur;

    // ---- 0. 标记停止，demux 循环检测到此标志退出 ----
    _isPlaying.store(false);

    // ---- 1. 通知 decoders 进入 seek 模式，跳过 drain 逻辑 ----
    _seekInProgress.store(true);

    // ---- 2. abort packet 队列：唤醒阻塞在 pop() 上的 decoder 线程 ----
    _videoPacketQueue.abort();
    _audioPacketQueue.abort();

    // ---- 3. 短暂等待，让 decoders 退出 codec 操作进入 spin 状态 ----
    std::this_thread::sleep_for(std::chrono::milliseconds(5));

    // ---- 4. 停止并等待 demux 线程退出 ----
    _demuxer.interrupt();
    if (_demuxThread.joinable()) {
        _demuxThread.join();
    }
    _demuxer.clearInterrupt();

    // ---- 5. decoders 已暂停，安全 flush ----
    _videoDecoder.flush();
    if (_hasAudio) {
        _audioDecoder.flush();
    }

    // ---- 6. 清空队列旧数据 ----
    _videoPacketQueue.clear();
    _audioPacketQueue.clear();
    _videoFrameQueue.clear();
    _audioFrameQueue.clear();

    // ---- 7. 通知 audio consumer 下一个帧按首帧处理，重新对齐时钟 ----
    if (_hasAudio) {
        _audioOutput.requestClockReset();
    }

    // ---- 8. reset 队列（清除 abort 标记） ----
    _videoPacketQueue.reset();
    _audioPacketQueue.reset();
    _videoFrameQueue.reset();
    _audioFrameQueue.reset();

    // ---- 9. FFmpeg 文件 seek ----
    _demuxer.seek(seconds);

    // ---- 10. 时钟跳到目标位置（作为 seek 到首帧到达前的临时值） ----
    _clock->setTime(seconds);

    // ---- 11. 重启 demux 线程 ----
    _isPlaying.store(true);
    _demuxThread = std::thread(&PlayerController::demuxLoop, this);

    // ---- 12. 通知 decoders seek 完成，恢复正常 ----
    _seekInProgress.store(false);

    _seeking.store(false);
}
```

Seek 涉及线程重启，设置 `_seeking` 原子标志防止长按拖拽导致的连续重入。

操作必须按严格顺序执行，否则会遇到"线程正阻塞在 `av_read_frame` 内部，无法安全操作 codec 上下文"等问题。以下是 12 个步骤以及它们的顺序原因：

| 步骤 | 操作 | 目的 |
|:---:|---|---|
| 0 | `_isPlaying = false` | 通知 demux 循环退出（它每次迭代检查此标志） |
| 1 | `_seekInProgress = true` | 通知 decoder 进入 seek 模式，跳过 drain 逻辑 |
| 2 | abort 两个 PacketQueue | 唤醒阻塞在 `pop()` 上的 decoder 线程 |
| 3 | `sleep(5ms)` | 给 decoder 线程一个窗口退出 codec 内部操作 |
| 4 | `_demuxer.interrupt()` + `join()` | 中断可能阻塞在 `av_read_frame` 的 demux 线程，等待退出 |
| 5 | `flush()` decoder | 清空 codec 内部缓存的帧（现在 decoder 已不消费 packet，安全） |
| 6 | `clear()` 四个队列 | 丢弃所有旧数据（packet 和 frame） |
| 7 | `requestClockReset()` | 下一个音频帧将按首帧处理，重新对齐时钟到真实 PTS |
| 8 | `reset()` 四个队列 | 清除 abort 标记，队列恢复可 push/pop 状态 |
| 9 | `_demuxer.seek(seconds)` | 调用 FFmpeg 跳转到目标位置 |
| 10 | `_clock->setTime(seconds)` | 时钟先跳到目标位置（临时值，首帧到达后再由 AudioOutput 精确修正） |
| 11 | 重启 demux 线程 | `_isPlaying = true` 后启动新的 demux 循环 |
| 12 | `_seekInProgress = false` | 通知 decoder 恢复正常模式 |


Seek 的底层 FFmpeg 调用由 `Demuxer::seek()` 封装：

```C++
bool Demuxer::seek(double seconds) {
    if (!_formatContext) return false;
    if (seconds < 0) seconds = 0;

    int64_t timestamp = static_cast<int64_t>(seconds * AV_TIME_BASE);
    int ret = av_seek_frame(_formatContext, -1, timestamp, AVSEEK_FLAG_BACKWARD);
    if (ret < 0) {
        // ... 错误处理 ...
        return false;
    }
    return true;
}
```

`av_seek_frame` 的四个参数：

| 参数 | 值 | 说明 |
|---|---|---|
| `AVFormatContext*` | `_formatContext` | 文件上下文 |
| `stream_index` | `-1` | 按文件全局时间跳转（不绑定特定流） |
| `timestamp` | `seconds × AV_TIME_BASE` | 目标时间戳 |
| `flags` | `AVSEEK_FLAG_BACKWARD` | 跳转到目标时间**之前**最近的关键帧 |

当 `stream_index = -1` 时，`timestamp` 的单位是 **`AV_TIME_BASE`**（FFmpeg 内部定义为 `1,000,000`，即微秒）。所以传入的 `seconds` 需要乘以 `AV_TIME_BASE`。

如果 `stream_index` 指定了具体流，timestamp 的单位就是该流的 `time_base`，即用**流的 PTS 值**直接传入。本播放器传 `-1` 按全局时间 Seek，逻辑更简单。

**`AVSEEK_FLAG_BACKWARD`** 让 FFmpeg 找到目标时间戳之前最近的关键帧作为解码起点。这种方法最安全——关键帧之后的所有帧都可以正常解码还原。

`av_seek_frame` 的主要 flags：

| flag | 行为 |
|---|---|
| `AVSEEK_FLAG_BACKWARD` | **默认推荐**。跳到时间戳之前最近的关键帧 |
| `AVSEEK_FLAG_BYTE` | 按字节偏移跳转（非按时间），用于原始流 |
| `AVSEEK_FLAG_ANY` | 强跳到指定帧（即使是非关键帧）。慎用——跳转点之后直到下一个关键帧会出现花屏 |
| `AVSEEK_FLAG_FRAME` | 将 timestamp 视为帧序号而非时间 |
