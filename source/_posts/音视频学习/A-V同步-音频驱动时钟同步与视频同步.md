---
title: 播放器开发--A/V同步(2)
date: 2026-05-12 14:33:53
categories: [音视频学习]
tags:
  - C++
  - Qt6
  - FFmpeg
  - OpenGL
cover: /images/pictures/音视频学习/luoyu119111703.jpg
---

上一篇我们讲了时间戳转换和 Clock 类的实现，但一个关键问题没有回答：**谁在驱动时钟？** 答案就是本篇的主角 —— AudioOutput 消费线程。它往声卡写入 PCM 数据的同时持续更新时钟，VideoSurface 再以此时钟为基准同步视频帧。

本篇从音频驱动时钟和视频同步两方面来讲解。

## 音频驱动时钟

这部分逻辑主要由AudioOutput类来负责。

### `consumeLoop(FrameQueue& queue)` 函数


```C++
void AudioOutput::consumeLoop(FrameQueue& queue) {

    bool firstFrame = true;
    double nextAudioPts = 0.0;
    constexpr double kOutputLatencyCompensation = 0.015;
    bool wasPaused = false;

    while (_running.load()) {

        // 检测 _pause 状态变化，由消费者线程独占调用 QAudioSink::suspend/resume
        bool nowPaused = _pause.load();
        if (nowPaused != wasPaused) {
            wasPaused = nowPaused;
            if (nowPaused && _audioSink) {
                _audioSink->suspend();
            } else if (!nowPaused && _audioSink) {
                _audioSink->resume();
            }
        }

        if (nowPaused) {
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
            continue;
        }

        FramePtr frame = queue.pop(); // 使用阻塞的 pop，避免 CPU 100% 空转
        if (!frame || !_audioDevice) {
            continue;
        }

        // 安全校验：时钟可能尚未设置（PlayerController 应保证先 setClock 再 start）
        if (!_clock) {
            std::cerr << "AudioOutput: Clock is null, cannot sync!" << std::endl;
            continue;
        }

        // data[0] 指向 S16 interleaved 的连续内存
        // 总字节数 = 采样点数 × 声道数 × 2 字节/采样
        int bytesPerSample = 2;  // sizeof(int16_t)
        int dataSize = frame->nb_samples
                     * frame->ch_layout.nb_channels
                     * bytesPerSample;

        double duration = double(frame->nb_samples) / frame->sample_rate;
        double bytesPerSecond = frame->sample_rate
                              * frame->ch_layout.nb_channels
                              * bytesPerSample;
        double frameStartPts = nextAudioPts;
        if (frame->pts != AV_NOPTS_VALUE && frame->time_base.den != 0) {
            frameStartPts = frame->pts * av_q2d(frame->time_base);
        }

        // ---- 首帧 / seek 后时钟重置：用真实 PTS 初始化时钟 ----
        if (firstFrame || _clockResetRequested.exchange(false)) {
            nextAudioPts = frameStartPts;
            _clock->setTime(frameStartPts);
            if (firstFrame) {
                std::cout << "AudioOutput: Clock initialized to "
                          << _clock->getTime() << "s" << std::endl;
            }
        }

        // 如果解码帧 PTS 与连续写入位置偏差过大，说明有跳变或断档，重新对齐。
        if (std::abs(nextAudioPts - frameStartPts) > 0.1) {
            nextAudioPts = frameStartPts;
        }

        const char* dataPtr = reinterpret_cast<const char*>(frame->data[0]);
        int bytesLeft = dataSize;

        // 每写入 1 字节代表多少秒
        double timePerByte = duration / static_cast<double>(dataSize);

        while (bytesLeft > 0 && _running.load() && !_pause.load()) {
            // Qt 核心：QAudioSink 的 bytesFree() 会告诉你目前硬件缓冲区还能吃下多少字节
            int freeBytes = _audioSink->bytesFree();
            
            if (freeBytes > 0) {
                // 如果有空闲，我们最多只写我们剩下的数据，不会越界
                int chunk = std::min(bytesLeft, freeBytes);
                // 把这段数据丢给声卡
                qint64 written = _audioDevice->write(dataPtr, chunk);
                if (written <= 0) {
                    std::cerr << "AudioOutput: Write error!" << std::endl;
                    break;
                }
                // 更新剩余的字节数和当前数据读取指针
                bytesLeft -= (int)written;
                dataPtr += written;

                // QAudioSink 先进入设备缓冲，再真正播放。时钟必须反映已播放位置，所以要减去"设备缓冲中还未播放的部分"。
                nextAudioPts += written * timePerByte;
                qint64 queuedBytes = std::max<qint64>(0, _audioSink->bufferSize() - _audioSink->bytesFree());
                double queuedSeconds = queuedBytes / bytesPerSecond;
                _clock->setTime(nextAudioPts - queuedSeconds - kOutputLatencyCompensation);
            } else {
                // 声卡缓冲区满，挂起等待
                std::this_thread::sleep_for(std::chrono::milliseconds(5));
            }
        }

        firstFrame = false;
    }

    std::cout << "AudioOutput: Consumer loop ended." << std::endl;
}
```
整个函数可以拆成三个阶段：**取帧 → PTS 计算与时钟初始化 → 写入设备并更新时钟**。下面逐个分析。

### 阶段一：从队列取帧

```C++
FramePtr frame = queue.pop(); // 阻塞式 pop，队列空时挂起而非忙等
if (!frame || !_audioDevice) {
    continue;
}
```

`queue.pop()` 是阻塞操作——队列为空时线程挂起在条件变量上，不消耗 CPU。这一点很关键：消费循环不会空转浪费资源。

### 阶段二：PTS 计算与时钟初始化

```C++
double frameStartPts = nextAudioPts;                                  // 兜底值
if (frame->pts != AV_NOPTS_VALUE && frame->time_base.den != 0) {
    frameStartPts = frame->pts * av_q2d(frame->time_base);            // 真实 PTS
}

// 首帧 / seek 后：用真实 PTS 重置时钟
if (firstFrame || _clockResetRequested.exchange(false)) {
    nextAudioPts = frameStartPts;
    _clock->setTime(frameStartPts);
}

// 断档检测：下一帧 PTS 与预期连续写入位置偏差 > 100ms → 重新对齐
if (std::abs(nextAudioPts - frameStartPts) > 0.1) {
    nextAudioPts = frameStartPts;
}
```

几点说明：

- **`frameStartPts` 的兜底策略**：先用 `nextAudioPts`（上一帧写入结束的时间）初始化，再尝试从帧的 `pts * av_q2d(time_base)` 算出真实时间。如果帧的 PTS 无效（`AV_NOPTS_VALUE`）或 time_base 分母为零，就用兜底值保证播放不中断。
- **`AV_NOPTS_VALUE`**：FFmpeg 定义的常量（通常是一个极小的负数），表示"此帧无有效 PTS"。
- **`_clockResetRequested.exchange(false)`**：原子操作，Seek 后由 `PlayerController` 通过 `requestClockReset()` 置为 `true`。这里读取并清零，触发时钟重新初始化。
- **断档对齐**：`nextAudioPts` 是按写入字节连续累加的时间戳，正常情况应该紧挨着下一帧的 `frameStartPts`。如果差值超过 100ms，说明发生了 Seek 跳转或者解码丢帧，直接用帧的真实 PTS 覆盖写入指针。

### 阶段三：写入设备并更新时钟

这是时钟驱动的核心。先理解三个关键概念：

| 变量 | 含义 |
|---|---|
| `nextAudioPts` | **写入指针**：已递交给声卡的全部数据对应的末尾时间点 |
| `queuedSeconds` | **缓冲区延迟**：`(bufferSize - bytesFree) / bytesPerSecond`，声卡缓冲区里尚未播放的数据时长 |
| `kOutputLatencyCompensation` | **固定补偿**：15ms，抵消驱动调度、DMA 搬运等无法通过 API 获取的隐性延迟 |

**时钟公式**：

```
真实播放位置 = nextAudioPts - queuedSeconds - kOutputLatencyCompensation
```

为什么这样算？`nextAudioPts` 记的是"我已经写到哪里了"，但写入不等于播放——数据先进入声卡硬件缓冲区排队，经过一段延迟后才从扬声器出来。`queuedSeconds` 就是这段"已写入但还没播放"的时间。减去它，就得到了当前扬声器正在播放的位置。再减去 15ms 的固定开销，就是更接近用户实际听到的时刻。

写入循环的核心代码：

```C++
while (bytesLeft > 0 && _running.load() && !_pause.load()) {
    int freeBytes = _audioSink->bytesFree();
    if (freeBytes > 0) {
        int chunk = std::min(bytesLeft, freeBytes);
        qint64 written = _audioDevice->write(dataPtr, chunk);
        if (written <= 0) break;

        bytesLeft -= written;
        dataPtr   += written;

        nextAudioPts += written * timePerByte;                         // 推进写入指针
        qint64 queuedBytes = std::max<qint64>(0,
            _audioSink->bufferSize() - _audioSink->bytesFree());
        double queuedSeconds = queuedBytes / bytesPerSecond;
        _clock->setTime(nextAudioPts - queuedSeconds - kOutputLatencyCompensation);
    } else {
        std::this_thread::sleep_for(std::chrono::milliseconds(5));     // 缓冲区满，等待
    }
}
```

每次 `write()` 后立即更新时钟，频率很高（每次写入一个 chunk 就更新一次），保证了视频同步侧随时读到最新的播放位置。`bytesFree()` 为 0 时说明声卡缓冲区已满，睡眠 5ms 等待硬件消费。

### 帧播放时间的计算

每次 `write()` 后需要更新 `nextAudioPts`，但写入的是**字节**，时钟需要的是**秒**。怎么换算？回顾一下在写入循环之前计算的几个变量：

```C++
int     dataSize      = frame->nb_samples * frame->ch_layout.nb_channels * 2;   // 一帧总字节数
double  duration      = double(frame->nb_samples) / frame->sample_rate;          // 一帧总秒数
double  bytesPerSecond = frame->sample_rate * frame->ch_layout.nb_channels * 2;  // 每秒字节数
double  timePerByte   = duration / static_cast<double>(dataSize);                // 每字节秒数
```

**`duration`**：一个音频帧的物理时长。

```
duration = nb_samples / sample_rate
```

例如 48000Hz 采样率、一帧 1024 个采样点，这一帧的时长就是 `1024 / 48000 ≈ 21.3ms`。

**`dataSize`**：这一帧占多少字节。

```
dataSize = nb_samples × nb_channels × bytesPerSample
```

以 S16（`bytesPerSample = 2`）立体声为例：`1024 × 2 × 2 = 4096` 字节。

**`bytesPerSecond`**：音频流的**数据速率**，由格式决定，对整个流是常量。

```
bytesPerSecond = sample_rate × nb_channels × bytesPerSample
```

S16 立体声 48000Hz 下：`48000 × 2 × 2 = 192000` 字节/秒。

**`timePerByte`**：最关键的一步推导。

```
timePerByte = duration / dataSize

            = (nb_samples / sample_rate) / (nb_samples × nb_channels × bytesPerSample)

            = 1 / (sample_rate × nb_channels × bytesPerSample)

            = 1 / bytesPerSecond
```

代入数值：`timePerByte = 1 / 192000 ≈ 0.0000052` 秒，即每字节约 **5.2 微秒**。


**`nextAudioPts` 的更新**：

```
nextAudioPts += written × timePerByte
```

每次写入 `written` 字节，就推进 `written × (1 / bytesPerSecond)` 秒。一个帧可能分多次写入（取决于声卡缓冲区每次的 `bytesFree()`），每次写入后都更新时钟，保证时钟随时反映最新的写入进度。

**带数值的完整示例**：

假设 S16 立体声 48000Hz，每帧 1024 采样点：

| 变量 | 算式 | 值 |
|---|---|---|
| `duration` | `1024 / 48000` | ≈ 21.3 ms |
| `dataSize` | `1024 × 2 × 2` | 4096 bytes |
| `bytesPerSecond` | `48000 × 2 × 2` | 192000 bytes/s |
| `timePerByte` | `21.3ms / 4096` = `1 / 192000` | ≈ 5.2 μs |

一次写入 2048 字节 → 推进 `2048 × 5.2μs ≈ 10.7ms`。写完整帧（4096 字节）→ 推进 21.3ms，与帧的理论时长一致。

---

## 视频同步到时钟

音频时钟持续更新后，视频侧的同步就变得简单了：每帧渲染前，拿帧的 PTS 跟 `clock.getTime()` 对比，决定**等待**、**丢弃**还是**立即显示**。

这部分逻辑在 `VideoFboRenderer::synchronize()` 中实现。`VideoFboRenderer` 是 `QQuickFramebufferObject::Renderer` 的子类，运行在 Qt 的**渲染线程**（独立于 GUI 主线程）。Qt 在每次 vsync 前回调 `synchronize()`，给我们机会决定用哪一帧。

```C++
void synchronize(QQuickFramebufferObject *item) override {
    constexpr double kMaxVideoLead     = 0.008;    // 视频最多领先音频 8ms
    constexpr double kDropFrameThreshold = -0.120;  // 视频落后超过 120ms 则丢帧

    VideoSurface *surface = static_cast<VideoSurface *>(item);
    FrameQueue *queue     = surface->frameQueue();
    Clock *clock          = surface->clock();

    if (!queue || queue->empty()) return;

    double clockTime  = clock ? clock->getTime() : 0.0;
    bool drainingTail = queue->draining();

    FramePtr frame;
    while (true) {
        // 窥视队首帧的 PTS 信息（不取出）
        const AVFrame* rawFrame = nullptr;
        int64_t pts = AV_NOPTS_VALUE;
        AVRational timeBase{0, 1};
        bool hasFrame = queue->try_inspect_front([&](const FramePtr& candidate) {
            if (candidate) {
                rawFrame = candidate.get();
                pts      = candidate->pts;
                timeBase = candidate->time_base;
            }
        });
        if (!hasFrame || !rawFrame) {
            if (frame) break;  // 有之前丢帧留下的候补帧，用它
            return;
        }

        if (pts == AV_NOPTS_VALUE || timeBase.den == 0) {
            break;  // PTS 无效，直接显示
        }

        double framePts = pts * av_q2d(timeBase);
        double diff     = framePts - clockTime;
        bool protectTailFrame = queue->protectsTailFrame(framePts);

        // ---- 情况 1：帧太早了，等 ----
        if (diff > kMaxVideoLead) {
            if (frame) break;  // 如果有候补帧，先显示它
            item->update();    // 请求下次 vsync 再检查
            return;
        }

        // ---- 情况 2：帧太晚了，丢 ----
        if (!drainingTail && !protectTailFrame
            && diff < kDropFrameThreshold && queue->size() > 3) {
            FramePtr dropped;
            queue->try_pop_if([rawFrame](const FramePtr& candidate) {
                return candidate && candidate.get() == rawFrame;
            }, dropped);
            if (!dropped) break;
            frame = std::move(dropped);  // 保留候补，万一后面没帧可用
            continue;                    // 继续检查下一帧
        }

        // ---- 情况 3：时间合适，取出并显示 ----
        queue->try_pop_if([rawFrame](const FramePtr& candidate) {
            return candidate && candidate.get() == rawFrame;
        }, frame);
        break;
    }
    if (!frame) return;

    // ... 后续：根据 frame 的像素格式创建/更新 YUV→RGB 渲染器，上传纹理 ...
}
```

### 同步决策逻辑

核心判断：`diff = framePts - clockTime`

| 条件 | 含义 | 动作 |
|---|---|---|
| `diff > 8ms` | 视频帧领先音频 | **等待**——return，等下次 vsync 再检查 |
| `-120ms < diff < 8ms` | 在容忍窗口内 | **显示**——取出这一帧，渲染 |
| `diff < -120ms` | 视频帧落后音频太多 | **丢弃**——pop 掉，保留候补继续检查下一帧 |

三个阈值的设计考量：

- **`kMaxVideoLead = 8ms`**：比一帧的持续时间（16.7ms @ 60fps）短。如果视频领先超过 8ms，等一等就能对齐；如果领先不足 8ms，肉眼几乎无法察觉，直接显示即可。
- **`kDropFrameThreshold = -120ms`**：视频严重落后时，与其积压越来越严重，不如主动丢帧追赶。120ms 大约 7-8 帧 @ 60fps。
- **`queue->size() > 3`**：丢帧的前提是队列里还有足够多的帧。如果只剩 3 帧以下，说明已经快没数据了，再丢可能导致画面冻结——此时宁可不丢，慢一点播放。

### `frame` 候补帧机制

注意 `frame` 是一个局部变量，存储被丢弃的帧。如果连续丢多帧后下一帧又太早（`diff > kMaxVideoLead`），就用候补帧先顶上去，避免画面饿死。

### 队尾保护（Tail Protection）

文件播放到末尾时，解码器调用 `queue->markDraining()` 进入 drain 模式，同时调用 `queue->protectTailFrom(lastPts)` 标记最后几帧的 PTS 范围。`protectsTailFrame()` 返回 `true` 时，说明这一帧属于"队尾保护区"——即使 `diff < -120ms` 也**不丢**，保证最后几帧一定能显示出来，而不是被丢弃导致视频提前结束。

这些逻辑确保了在"队尾帧可能非常接近、时间间隔不规则"的情况下，视频依然能优雅地播放到最后一帧。

## 小结

整个 A/V 同步链路：

1. **AudioOutput** 消费音频帧写入声卡，每次写入后更新 Clock：`真实播放时间 = 写入总量 - 缓冲区未播量 - 固定补偿`
2. **Clock** 在两次 `setTime()` 之间用 wall-clock 外推，提供连续、平滑的时间读数
3. **VideoSurface** 的 `synchronize()` 每次 vsync 前用 `diff = framePts - clockTime` 做三选一：等待、丢弃、显示

音频是"推"时钟的一方，视频是"跟"时钟的一方。人耳对音频抖动敏感，同时时钟由声卡晶振驱动、极其稳定；人眼对偶尔的重帧/跳帧容忍度较高，所以视频侧用丢帧和等待来追赶。

下一篇将讲解音频的重采样以及音频的播放。

---

这次的插图来自画师`luoyu`

图片地址：https://www.pixiv.net/artworks/119111703

本项目源码请看：https://github.com/DongGuZhengHuaJi/VideoPlayer

