---
title: Lambda表达式介绍
date: 2026-09-18 15:46:35
tags: [C++, Lambda, 闭包, 捕获列表, std::bind]
categories: [现代C++学习]
cover: /images/pictures/现代C++学习/Rune Xiao123634161.jpg
---

# Lambda 本质

在 lambda 之前，你肯定接触过仿函数（Functor / Function Object，函数对象）这个概念。比如：

```cpp
struct Add {
    int operator()(int x) const {
        return x + 10;
    }
};
```

对于一个类或者结构体，我们可以重载它的函数调用运算符 `operator()`，让对象拥有类似函数的行为：

```cpp
Add add;

std::cout << add(5);    // 15
```

这里的 `add(5)` 实际上就是 `add.operator()(5)`。

而 lambda 基本是同样的原理，区别在于这个类由编译器自动生成：它是一个匿名的闭包类（closure class），每一个 lambda 表达式都会生成一个独一无二的类型。因此我们通常使用 `auto` 推导它的类型，而无法（也没有必要）显式写出类型名。

一个 lambda 表达式由三部分组成：捕获列表、参数列表以及函数体：

```cpp
[捕获列表](参数列表) {
    函数体
}
```

除此之外，lambda 还支持 `mutable`、`noexcept`、尾置返回类型等可选部分，完整的语法形式如下：

```cpp
[捕获列表](参数列表) mutable noexcept -> 返回类型 {
    函数体
}
```

其中 `mutable` 与返回类型的推导规则会在后文详细介绍。

## Capture 捕获

如果一个 lambda 表达式没有访问任何外部变量，我们称它是无状态的（stateless）；反之，如果它捕获了外部作用域中的变量，就是有状态的（stateful）。

闭包类虽然是在 lambda 所在的作用域中生成的，但它的成员函数 `operator()` 是一个独立的作用域，无法直接访问外围函数的局部变量。因此想要在 lambda 内部使用外部变量，就必须先在捕获列表中把它"搬"进闭包类。

lambda 表达式的捕获方式主要有值捕获、引用捕获和初始化捕获，此外还有 `[=]` 和 `[&]` 两种默认捕获模式。

### 值捕获

值捕获会在闭包类内部拷贝一份被捕获的变量，语法是在捕获列表中直接写出变量名：

```cpp
int divisor = 5;
int remainder = 0;

// 值捕获：闭包内部持有 divisor、remainder 各一份副本
auto isDivisible = [divisor, remainder](int value) {
    return value % divisor == remainder;
};

std::cout << isDivisible(15);   // true
```

值捕获能够且只能捕获在 lambda 声明所在作用域内可见的非静态局部变量（包括函数形参），并在闭包类内部拷贝一份数据。

由于闭包类的 `operator()` 默认带有 `const` 限定，这份副本在 lambda 内部默认是只读的，想要修改就必须加上 `mutable`（详见后文）。

值捕获在直觉上不会因为捕获对象的生命周期引发问题，但是事实并非如此。比如当你尝试使用值捕获方式获取成员变量时：

```cpp
// 全局容器：std::vector<std::function<bool(int)>> filters;

class Widget {
public:
    void addFilter() const {
        filters.emplace_back(
            [=](int value) { return value % divisor == 0; }
        );
    }
private:
    int divisor = 5;
};
```

这里的 `[=]` 是默认值捕获模式，表示"按值捕获 lambda 中用到的所有外部变量"。但是成员变量 `divisor` 并不是局部变量，无法直接复制一份，于是编译器会将代码隐式转换成类似这样：

```cpp
filters.emplace_back(
    [this](int value) { return value % this->divisor == 0; }
);
```

也就是说，`[=]` 在这里复制的其实是 `this` 指针，而不是 `divisor` 的值，lambda 通过这份指针间接访问成员变量。一旦 `Widget` 对象先于 lambda 被销毁，`this` 就会变成悬空指针，再次调用该 lambda 便会崩溃。

另外需要注意的是，`[=]` 隐式捕获 `this` 的做法在 C++20 中已经被弃用，编译器会给出警告，需要显式写成 `[=, this]`。

如果想按值捕获成员变量，可以使用 C++14 的初始化捕获或者 C++17 的捕获 `*this` 副本，当然也可以在局部作用域复制一份成员变量，再由 lambda 捕获这个副本：

```cpp
void Widget::addFilter() const {
    auto divisorCopy = divisor;     // 在局部作用域复制一份成员变量
    filters.emplace_back(
        [divisorCopy](int value) { return value % divisorCopy == 0; }
    );
}
```

有时，使用值捕获并不意味着 lambda 内部一定持有变量的副本，比如遇到静态变量（static）时：

```cpp
void addFilter() {
    static int divisor = 5;     // 静态变量

    filters.emplace_back(
        [=](int value) { return value % divisor == 0; }
    );

    divisor = 10;               // 修改静态变量
}
```

尽管使用了 `[=]`，lambda 并没有复制 `divisor`，因为它既不是局部变量也不是 `this` 指针。lambda 会直接引用静态变量 `divisor`，因此外部对 `divisor` 的修改会直接影响 lambda 的执行结果：上面这个例子中，后续调用该 lambda 时比较的已经是 `10` 而不是 `5`。

同理，全局变量也不会被捕获，lambda 会直接引用它们。这说明值捕获的"值"只对非静态局部变量成立，静态变量和全局变量始终是与外部共享的。

### 引用捕获

引用捕获会在闭包类内部持有一份被捕获变量的引用，语法是在变量名前加上 `&`：

```cpp
int divisor = 5;

// 引用捕获：闭包内部持有 divisor 的引用
auto isDivisible = [&divisor](int value) {
    return value % divisor == 0;
};

std::cout << isDivisible(15);   // true

divisor = 10;                   // 修改外部变量
std::cout << isDivisible(15);   // false，闭包内的引用同步生效
```

引用捕获能够且只能捕获在 lambda 声明所在作用域内可见的非静态局部变量（包括函数形参），并在闭包类内部持有一份引用。

由于持有的是引用而非副本，闭包读取到的值与外部变量始终同步，也正因如此，在 lambda 内部可以直接修改外部变量，不需要 `mutable`。

但是如果 lambda 的生命周期长于被捕获的变量（比如把 lambda 存入容器、作为异步回调或函数返回值返回），当变量出了作用域被销毁后，闭包内部的引用就会变成悬空引用，引发未定义行为：

```cpp
std::function<bool(int)> makeFilter() {
    int divisor = 5;
    return [&divisor](int value) { return value % divisor == 0; };  // 危险！
}   // divisor 在此被销毁，返回的 lambda 内部持有悬空引用
```

在 C++11 中，引用捕获还有一个用途：捕获无法拷贝的对象，比如 `std::ostream`、`std::unique_ptr` 等。不过这同样无法保证生命周期安全，C++14 之后应当优先使用初始化捕获。

### 初始化捕获

C++11 中，lambda 只支持按值捕获或按引用捕获，这引发了一个问题：无法将"仅支持移动、不支持拷贝"的对象（如 `std::unique_ptr`、`std::future`、`std::thread` 等）按值捕获进 lambda 中。

于是 C++14 引入了初始化捕获（init capture），其语法格式为 `[闭包内的新变量名 = 外部表达式]`。等号左边是闭包类中新引入的成员变量名，右边则是在 lambda 所在作用域中求值的初始化表达式。

使用初始化捕获可以完美支持移动语义：

```cpp
auto ptr = std::make_unique<Widget>();

// C++14：将 ptr 移动给闭包内部的新变量 pw
auto lambda = [pw = std::move(ptr)]() {
    pw->doSomething();
};

// 执行后，外部的 ptr 变为空指针，所有权成功转移进 Lambda 闭包内
```

通过初始化捕获和 `std::move`，我们实现了 lambda 对独占资源的使用。

初始化捕获不只可以捕获外部变量，也可以直接在捕获列表中构造/初始化变量：

```cpp
// 在捕获列表中直接创建并初始化变量
auto lambda = [pw = std::make_unique<Widget>()]() {
    pw->doSomething();
};
```

如果是在 C++11 中想实现初始化捕获的类似功能，可以使用 `std::bind`。比如把一个 `std::vector<double>` 移入闭包：

```cpp
// C++14 的写法
auto func = [data = std::move(data)] { /* 使用 data */ };
```

```cpp
// C++11 的模拟写法：lambda 接收 const 引用，bind 对象负责持有 vector
auto func = std::bind(
    [](const std::vector<double>& data) { /* 使用 data */ },
    std::move(data)
);
```

对于只能移动的对象也是类似的思路：

```cpp
// C++14 的写法
auto func = [pw = std::make_unique<Widget>()] {
    return pw->isValidated() && pw->isArchived();
};
```

```cpp
// C++11 的模拟写法
auto func = std::bind(
    [](const std::unique_ptr<Widget>& pw) {     // 只能接收引用，无法按值接收
        return pw->isValidated() && pw->isArchived();
    },
    std::make_unique<Widget>()
);
```

这两种写法看似等价，但 C++11 的模拟版本存在两个明显缺陷：

1. `std::bind` 会把绑定的实参以左值的形式传递给目标可调用对象，因此 lambda 无法按值接收 `std::unique_ptr`，只能退而使用 `const` 引用，也就没有真正把对象"移进闭包"。

2. lambda 对象被存放在 `bind` 对象内部，调用时需要穿透 `std::bind` 的模板层级，编译器很难将其内联。

因此，C++14 之后没有必要再使用这种写法。

### 尽量使用显式捕获

前面几个例子中出现的 `[=]` 和 `[&]` 被称为默认捕获模式：它们不列出具体的变量名，而是让编译器自行判断 lambda 中到底用到了哪些外部变量，再统一按值或按引用捕获。

默认捕获模式写起来省事，但会把"捕获了谁"和"以何种方式捕获"这两个关键信息隐藏起来，从而带来一些问题：

- `[&]` 无法保证被引用对象的生命周期，一旦 lambda 的生命周期更长，就会产生悬空引用；并且当 lambda 的函数体被修改、引入了新的外部变量时，这个变量会被悄悄捕获，很容易埋下隐患。

- `[=]` 看似安全，但遇到成员变量时会隐式捕获 `this` 指针，同样存在悬空风险，并且这一行为在 C++20 中已被弃用。

- 静态变量和全局变量不会被任何方式捕获，即使写出 `[=]` 也会直接引用外部对象，容易让人误以为操作的是副本。

因此更好的做法是显式写出每一个要捕获的变量，并标明捕获方式，例如 `[divisor, &count]`。这样不仅能避免上述陷阱，也让读者一眼就能看出哪些外部变量会被修改。

## mutable 与捕获变量的修改

闭包类的 `operator()` 默认带有 `const` 限定，因此通过值捕获得到的成员变量在 lambda 内部是只读的：

```cpp
int count = 0;

auto f = [count]() { return ++count; };     // 错误！不能修改 const 对象
```

想要修改这份副本，需要在参数列表之后加上 `mutable`：

```cpp
int count = 0;

auto f = [count]() mutable { return ++count; };

std::cout << f() << f() << f();     // 123
std::cout << count;                 // 仍然是 0
```

需要注意的是，`mutable` 修改的只是闭包内部的那份副本，外部变量 `count` 不受影响；并且这份副本的生命周期与闭包对象相同，因此多次调用 `f()` 会让状态持续累加。

对于引用捕获的变量则不需要 `mutable`：`operator()` 的 `const` 限定的是闭包对象自身，而引用成员无论是否为 `const`，都可以用来修改被引用的对象：

```cpp
int count = 0;

auto f = [&count]() { return ++count; };    // 不需要 mutable

std::cout << f();       // 1
std::cout << count;     // 1，外部变量被真正修改了
```

另外，`mutable` 会把 `operator()` 变成非 `const` 的版本，这意味着 `const` 的闭包对象将无法被调用，因此除非确有需要，否则不要无谓地添加 `mutable`。

## 返回类型的推导

lambda 的返回类型通常由编译器自动推导，但推导规则比较严格：函数体中所有 `return` 语句的表达式类型必须完全一致，否则编译器无法确定返回类型，只能报错：

```cpp
auto f = [](int x) {
    if (x > 0) return 1;    // 推导为 int
    return 2.0;             // 错误！推导结果不一致，无法确定返回类型
};
```

此时需要使用尾置返回类型显式指定：

```cpp
auto f = [](int x) -> double {
    if (x > 0) return 1;    // 隐式转换为 double
    return 2.0;
};
```

另外，当函数体只有一条 `return` 语句时，lambda 的推导规则与 `auto` 相同：会忽略顶层 `const` 和引用。因此如果需要返回引用，同样要显式写出返回类型：

```cpp
std::vector<int> v{1, 2, 3};

auto bad  = [&v]() { return v[0]; };            // 返回 int 的副本
auto good = [&v]() -> int& { return v[0]; };    // 返回引用
```

# 泛型 Lambda

C++14 允许在 lambda 的形参列表中使用 `auto` 关键字，从而创建泛型 Lambda（generic lambda）：

```cpp
// C++14 泛型 Lambda
auto f = [](auto x) { return normalize(x); };
```

编译器会将这个 lambda 转化为一个带有模板化 `operator()` 的闭包类：

```cpp
class ClosureClass {
public:
    template<typename T>
    auto operator()(T x) const {
        return normalize(x);
    }
};
```

也正因如此，`auto` 形参会像模板参数一样发生类型推导，泛型 lambda 可以接收任意支持 `normalize` 的类型。在 C++20 之后，还可以写成显式的模板参数列表 `[]<typename T>(T x) { ... }`。

## 使用 `decltype` 转发 `auto&&` 形参

我们可以使用万能引用类型作为 lambda 参数，从而在 lambda 函数内部实现完美转发。

在普通模板函数中，我们使用模板参数 `T` 进行完美转发：

```cpp
// 普通模板函数的完美转发
template<typename T>
void process(T&& param) {
    target(std::forward<T>(param));     // 需要显式指定模板参数 T
}
```

但是在 C++14 的泛型 Lambda 中，形参写为 `auto&& x`，没有显式的模板参数名 `T`，此时我们可以使用 `decltype(x)`：

```cpp
// 单参数
auto f = [](auto&& x) {
    return target(std::forward<decltype(x)>(x));
};

// 多参数
auto f = [](auto&&... xs) {
    return target(std::forward<decltype(xs)>(xs)...);
};
```

这里的 `decltype(x)` 得到的是形参 `x` 的声明类型（包含引用），也就是 `auto` 推导后与 `&&` 折叠出的类型，正好可以作为 `std::forward` 的模板实参。

如果传入的是左值（Lvalue，如 `int a`）：

- `x` 的推导类型是左值引用 `int&`。
- `auto&&` 成为 `int& &&`，发生引用折叠得到 `int&`。
- `decltype(x)` 的结果就是 `int&`。
- `std::forward<int&>(x)` 会将 `x` 作为左值转发给 `target`。

如果传入的是右值（Rvalue，如 `10` 或 `std::move(a)`）：

- `x` 的推导类型是右值引用 `int&&`。
- `auto&&` 成为 `int&& &&`，发生引用折叠得到 `int&&`。
- `decltype(x)` 的结果就是 `int&&`。
- 根据 `std::forward` 的实现机制，传递右值引用类型 `int&&` 能够正确将 `x` 作为右值转发给 `target`。

需要注意的是，`decltype` 多加一层括号后含义会发生变化：`decltype(x)` 得到的是变量 `x` 的声明类型，而 `decltype((x))` 得到的是表达式 `(x)` 的类型。由于带括号的具名变量是左值表达式，结果恒为左值引用 `int&`，写错会导致所有实参都被当作左值转发，彻底丢失右值语义：

```cpp
// 错误！decltype((x)) 恒为左值引用，完美转发失效
auto f = [](auto&& x) {
    return target(std::forward<decltype((x))>(x));
};
```

# `std::bind` 与 Lambda

`std::bind` 是 C++11 引入的一个"函数绑定器"，它的核心作用是：把一个现有的函数（或函数对象、成员函数）拿过来，"预先绑定"一部分参数，或者改变参数的顺序，从而生成一个新的可调用对象（Callable Object）。

它的基本调用格式如下：

```cpp
auto newCallable = std::bind(functions, arg1, arg2, ..., argN);
```

- 第一个参数：你要绑定的目标函数（或函数指针、成员函数指针、Lambda 等）。
- 后续参数：你要传给目标函数的参数。这些参数可以是具体的值，也可以是占位符（Placeholders）。

`std::bind` 确实很实用，但是与 lambda 相比，存在一些缺点。

## 1. 可读性差

假设我们要设置一个定时器：

使用 lambda：

```cpp
// 意图非常直接：在 steady_clock::now() + 1h 触发
auto setAlarm = [](Sound s) {
    using namespace std::chrono;
    setAlarmAt(steady_clock::now() + 1h, s);
};
```

使用 `std::bind`：

```cpp
using namespace std::chrono;
using namespace std::placeholders;

auto setAlarm = std::bind(
    setAlarmAt,
    std::bind(std::plus<steady_clock::time_point>(), steady_clock::now(), 1h),
    _1
);
```

在 `std::bind` 中，求值时机非常反直觉：如果直接传 `steady_clock::now() + 1h`，时间会在 `bind` 被调用的那刻计算，而不是在警报触发时计算。为了实现延迟响应，不得不嵌套另一个 `std::bind`，代码极其臃肿且难以阅读。

## 2. 处理重载与参数传递更容易出错

函数重载问题：

当 lambda 内部调用的函数被重载时，lambda 表达式无需修改便可以自动适应并匹配到正确的重载。

但是 `std::bind` 会编译报错，因为编译器无法确定要取哪个函数指针，你必须手动做强制类型转换：

```cpp
using SetAlarmFn = void(*)(steady_clock::time_point, Sound);
auto setAlarm = std::bind(static_cast<SetAlarmFn>(setAlarmAt), ..., _1);
```

参数按值/按引用：

在 `std::bind` 中，传递给绑定的实参默认都是按值拷贝的（除非显式包装 `std::ref`），而占位符（如 `_1`）则会把调用时的实参原样转发给目标函数。这种隐式行为极易引入 bug。

而在 Lambda 中，捕获列表和形参的传递方式全部写在函数签名里，尤其是像 `[&count, divisor]` 这样的显式捕获，哪些变量会被修改一目了然。

## 3. 运行效率差异

- Lambda 的内联：Lambda 表达式生成的是一个独一无二的闭包类，其 `operator()` 定义在类内部，因此默认是内联的。编译器可以非常轻松地将 Lambda 内部的调用内联展开，做到零开销抽象。

- `std::bind` 的开销：`std::bind` 返回的是一个通用函数对象，内部通过函数指针调用。绝大多数编译器很难穿透 `std::bind` 内部繁琐的模板层级去实现函数内联，因此 `std::bind` 往往伴随着额外的函数调用开销。

在 C++14 之后，初始化捕获和泛型 lambda 彻底抹平了 `std::bind` 的优势，因此优先使用 lambda 而不是 `std::bind` 总是更明智的做法。

`std::bind` 唯一还值得一提的场景是在 C++11 中转发数量不定的实参（C++11 的 lambda 形参列表是固定的），但这一场景在 C++14 的泛型 lambda 出现之后也已经不复存在了。

---

这次的插图来自画师 `Rune Xiao`

图片地址：https://www.pixiv.net/artworks/123634161

文章内容参考：**Effective Modern C++ 42 Specific Ways to Improve Your Use of C++11 and C++14 (Scott Meyers)** Item 31-Item 34
