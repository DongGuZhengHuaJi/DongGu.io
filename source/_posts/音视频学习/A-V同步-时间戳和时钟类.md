---
title: 播放器开发--A/V同步(1)
date: 2026-05-12 00:03:57
categories: [音视频学习]
tags:
  - C++
  - Qt6
  - FFmpeg
  - OpenGL
cover: /images/pictures/音视频学习/mmAir133941109.jpg
---

前面我们已经把解码后的 VideoFrame 和 AudioFrame 送入了各自的 FrameQueue。如果直接不管时间信息就去渲染播放，会发生什么？

视频和音频会各自以最大速度输出——画面飞速闪过，声音也失去了正常节奏。因为它们只是"有数据就消费"，没有人在协调节奏。

A/V 同步要解决的核心问题就是：**让视频和音频以正确的速度、在正确的时间点呈现，并且两者保持对齐。**

怎么对齐？我们需要一把"尺子"——**时间戳**。

---

## 时间戳

每个 `AVFrame` 和 `AVPacket` 都携带着时间信息：

- **DTS**（Decoding Time Stamp）：解码时间戳。告诉解码器这一帧应该在什么时候被解码。大多数情况下 DTS 和 PTS 相同，但存在 B 帧时 DTS 会早于 PTS。
- **PTS**（Presentation Time Stamp）：显示时间戳。告诉播放器这一帧应该在什么时候显示到屏幕上。
- **Timebase**（时间基）：PTS/DTS 的数值单位。PTS 本身是一个整数，需要乘以 time_base 才能得到以秒为单位的时间。

换算公式：

```
秒 = PTS × av_q2d(time_base)
```

例如 time_base = `1/1000`（即 `av_q2d` 返回 0.001），PTS = 500，那么这一帧应该在 **第 0.5 秒** 播放。

> A/V 同步主要关注 PTS。DTS 由 FFmpeg 内部在解码时使用，播放器的同步逻辑不需要关心它。

---

## 同步策略

同步需要一个**主时钟（Master Clock）**作为参考基准。主流方案有三种：

**1. 音频为主时钟（Audio Master）——最常用**

音频时钟由声卡晶振驱动，播放速度极其稳定。同时人耳对声音的抖动（Jitter）极其敏感，而眼睛对视频偶尔跳帧或重复帧的感知相对迟钝。

做法：
- 用当前音频播放位置作为主时钟
- 视频帧 PTS 跟主时钟对比：
  - 视频太快 → 休眠等待
  - 视频太慢 → 丢弃落后帧，追赶进度

本播放器采用的就是这个策略。

**2. 视频为主时钟（Video Master）**

以视频渲染速度为基准。问题是：如果为了对齐去拉伸或压缩音频（重采样），会导致声音变调（"电音感"），体验很差。通常只在特殊硬件环境使用。

**3. 外部时钟（External Clock）**

直接参考系统时钟。缺点是系统时钟可能漂移，且无法感知音视频输出设备的物理延迟。一般作为无音频流时的 fallback。

> 我会按 **时间基获取 → 时钟设计与实现 → 音频驱动时钟 → 视频同步到时钟** 的顺序讲解。本篇先覆盖前两部分。

---

## 时间基的获取与传递

Timebase 存储在文件的流信息中，需要从 Demuxer → PlayerController → Decoder 一路传递。

**Demuxer 端：取出流的时间基**

```C++
AVRational Demuxer::getVideoStreamTimeBase() const {
    if (!_formatContext || _videoStreamIndex < 0) {
        return AVRational{0, 1};
    }
    return _formatContext->streams[_videoStreamIndex]->time_base;
}

AVRational Demuxer::getAudioStreamTimeBase() const {
    if (!_formatContext || _audioStreamIndex < 0) {
        return AVRational{0, 1};
    }
    return _formatContext->streams[_audioStreamIndex]->time_base;
}
```

**PlayerController 端：传给解码器**

```C++
// play() 中初始化解码器时，同时传入对应流的时间基
_videoDecoder.init(videoParams, _demuxer.getVideoStreamTimeBase());
_audioDecoder.init(audioParams, _demuxer.getAudioStreamTimeBase());
```

**Decoder 端：保存供解码线程使用**

```C++
bool VideoDecoder::init(AVCodecParameters* codecpar, AVRational streamTimeBase) {
    // ...
    _codecContext->pkt_timebase = streamTimeBase;  // 告诉 FFmpeg 包的时间基
    _streamTimeBase = streamTimeBase;               // 自己保存一份，后续帧处理用
    // ...
}
```

`_streamTimeBase` 会在 `decodeLoop()` 中赋给每个解码出的 `AVFrame`：

```C++
frame->time_base = _streamTimeBase;
```

这样帧从解码器出来时 PTS 和时间基是配对的，后续任何模块拿到这个帧都能用 `av_q2d(time_base) * pts` 算出准确的秒数。

> **注意**：`AVRational` 是一个分数结构 `{num, den}`，使用时需要 `av_q2d()` 转为 `double`，等价于 `(double)num / den`。

---

## 时间的计算 —— Clock 类

时间基解决的是"PTS 怎么换算成秒"，但播放器还需要一个**运行时的钟**来跟踪"当前播放到第几秒了"。这个钟就是 `Clock` 类。

```C++
class Clock : public QObject {
    Q_OBJECT
public:
    explicit Clock(QObject* parent = nullptr);

    void setTime(double time);
    double getTime() const;
    void pause();
    void resume();

private:
    mutable std::mutex _mutex;
    double _current = 0.0;                              // 当前时间（秒）
    bool _pause = false;                                // 暂停标志
    std::chrono::steady_clock::time_point _lastUpdateTime; // 上次更新时间点
};
```

### 设计思路

Clock 不自己"走"，它依赖外部定期调用 `setTime()` 来更新。但两次 `setTime()` 之间可能有间隔（比如外部每 5ms 更新一次），而 `getTime()` 可能随时被调用。所以 Clock 的设计是"快照 + 外推"：

- `_current` + `_lastUpdateTime` 构成一个**快照**：记录"在某个 wall-clock 时刻，播放到了第 X 秒"
- `getTime()` 调用时，用当前 wall-clock 减去 `_lastUpdateTime`，把流逝的时间加到 `_current` 上，得到**外推的当前播放位置**

这样就得到了连续、平滑的时间读数，而不是跳变的离散值。

### `setTime(double time)`

```C++
void Clock::setTime(double time) {
    std::lock_guard<std::mutex> lock(_mutex);
    _current = time;
    _lastUpdateTime = std::chrono::steady_clock::now();
}
```

同时更新当前时间和基准时间点，构成一个新的快照。AudioOutput 每写入一批数据到声卡就会调用一次。

### `getTime()`

```C++
double Clock::getTime() const {
    std::lock_guard<std::mutex> lock(_mutex);
    if (_pause) {
        return _current;      // 暂停：返回冻结的时间
    } else {
        auto now = std::chrono::steady_clock::now();
        std::chrono::duration<double> elapsed = now - _lastUpdateTime;
        return _current + elapsed.count();  // 播放中：快照 + 外推
    }
}
```

暂停时直接返回 `_current`，不累加 wall-clock 流逝时间——因为播放已经停了。

### `pause()`

```C++
void Clock::pause() {
    std::lock_guard<std::mutex> lock(_mutex);
    if (!_pause) {
        auto now = std::chrono::steady_clock::now();
        std::chrono::duration<double> elapsed = now - _lastUpdateTime;
        _current += elapsed.count();  // 先把到此刻为止的时间算进来
        _pause = true;                // 再冻结
    }
}
```

暂停时先做一次"结算"——把从上次更新到这瞬间的时间差加进 `_current`，然后再冻结。如果跳过这一步，`getTime()` 在暂停后会丢失这段间隔内的播放进度。

### `resume()`

```C++
void Clock::resume() {
    std::lock_guard<std::mutex> lock(_mutex);
    if (_pause) {
        _lastUpdateTime = std::chrono::steady_clock::now();  // 重置基准点
        _pause = false;
    }
}
```

恢复时只需要把 `_lastUpdateTime` 重置为当前时刻，`_current` 不变。之后 `getTime()` 会从 `_current` 开始继续外推。

### 线程安全

Clock 会被**两个线程**同时访问：

| 线程 | 操作 | 频率 |
|---|---|---|
| AudioOutput 消费线程 | `setTime()`（写入） | 每次写入声卡后（高频） |
| Qt 渲染线程（VideoSurface） | `getTime()`（读取） | 每帧 `synchronize()` 时 |

所有读写操作都用 `std::mutex` 保护，`_mutex` 声明为 `mutable` 是因为 `getTime()` 是 `const` 方法但仍需要加锁。

---

## 接下来

上面讲了时间戳的概念、时间基的传递链、Clock 的设计与实现。一个关键的问题还没有回答：**谁在调用 `setTime()` 驱动时钟？** 答案是 AudioOutput 的消费线程——它在往声卡写入 PCM 数据的同时持续更新时钟。而 VideoSurface 的 `synchronize()` 方法读取 `clock.getTime()`，决定当前帧是显示、等待还是丢弃。

这两部分将在下一节 **"音频驱动时钟与视频同步"** 中详细展开。

---

这次的插图来自画师`mmAir`

图片地址：https://www.pixiv.net/artworks/133941109

本项目源码请看：https://github.com/DongGuZhengHuaJi/VideoPlayer
