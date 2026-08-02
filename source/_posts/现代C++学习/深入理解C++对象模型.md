---
title: 深入理解C++对象模型
date: 2026-07-28 19:22:09
tags: [C++, 面向对象, 虚函数, 内存模型]
categories: [现代C++学习]
cover: /images/pictures/现代C++学习/Aio131687603.jpg
---

# 关于对象

在 C 语言中，数据和处理数据的操作（函数）是分开声明的，也就是说语言本身没有直接支持数据与函数之间的关联性。我们称这种编程范式为过程式（procedural）的————由一组"分布在各个以功能为导向的函数中"的算法所驱动，它们处理的是共同的外部数据。

比如，在 C 语言中声明一个 struct Point3d：

```c
struct Point3d {
    float x;
    float y;
    float z;
};
```

如果我们想要打印这个 Point3d，就需要定义一个像这样的函数：

```c
void Point3d_print(const Point3d *point) {
    printf("(%f, %f, %f)\n", point->x, point->y, point->z);
}
```

当然，你也可以通过定义一些宏或者其他方法来简化这种操作。

但是无论如何，我们所定义的结构体 `Point3d` 与打印它的函数 `Point3d_print` 之间并没有什么语言层面的关联，打印函数只是通过指针参数获取外部的结构体变量并进行操作。

而在 C++ 中，我们可以用抽象数据类型（Abstract Data Type, ADT）来实现刚才的 Point3d：

```cpp
class Point3d {
public:
    float x, y, z;
    void print() const {
        // ...
    }
};
```

或者，你也可以通过继承层次来实现：

```cpp
class Point {
    // ...
};

class Point2d : public Point {
    // ...
};

class Point3d : public Point2d {
    // ...
};
```

你还可以通过 C++ 模板来进行泛型编程，实现坐标类型甚至坐标数目的参数化：

```cpp
template <typename T, int Dim>
class Point {
    T coords[Dim];
    // ...
};
```

我们将这种"数据和处理这些数据的方法（代码）的封装体"称为**对象**（Object）。

C++ 相对于 C 语言最大的特点就是引入了面向对象特性。虽然 C++ 的语法相对于 C 语言更加复杂，尤其是在使用了 template 的时候，但这并不意味着 C++ 代码的执行效率更低或内存成本更高。

虽然 member functions 封装在 class 的声明中，但是在编译之后，所有没有被编译器内联展开的 function 只会产生一个函数实体，存储在内存的代码区，因此并不会增加每个类对象的内存成本。被内联展开的 function 会在调用点直接展开，避免函数调用开销，同样不会增加类对象的内存成本。C++ 类对象相比 C 语言增加的内存成本主要在于 virtual 机制，包括：

- **virtual function 机制**：用以支持有效率的"执行期绑定"（runtime binding）。
- **virtual base class**：用以实现"多次出现在继承体系中的 base class，有一个单一而被共享的实体"。

对于这些内容，我们后续会进行具体的讨论。

## C++ 对象模型

在 C++ 中，有两种 class data member：static 和 nonstatic；有三种 class function member：static、nonstatic 和 virtual。

在 C++ 对象模型中，只有 nonstatic data member 被存放在每个 class object 的内存中，其他类型的 data 或 function member 都存储在内存的特定区域。

此外，如果类或其继承链中声明了 virtual function，编译器会为该类生成一张**虚表**（virtual table, vtbl），内部存储着指向各个 virtual function 的指针。虚表中还会存储 class 所关联的类型信息，用于支持运行时类型识别（Runtime Type Identification, RTTI），通常存储在 vtbl 的第一个 slot。

同时，class object 中会添加一个指向虚表的指针（vptr）。vptr 的设定和重置由类的构造函数和析构函数自动完成。

![C++ 对象模型示意图](/images/现代C++学习/cpp-object-model.png)

上图显示了一个 Point object 的内存布局。可见 object 的内存中只存储了 nonstatic data member 和 vptr；static data member 和 function member 存储在内存的其他位置；vtbl 中存储了 type_info 和指向各个 virtual function 的指针。

一个 class object 的内存组成大致包括以下几个方面：

- 所有 nonstatic data member 所需的内存总和。
- 为了支持 virtual 机制所增加的负担（vptr 等）。
- 编译器进行内存对齐（alignment）而填补（padding）的空间。

关于 alignment：由于机器是按字处理数据的，将内存调整到机器字长大小的倍数效率会更高。例如对于 64 位机器，将 class object 的内存使用量调整到 8 Byte 的倍数通常会提高数据处理的效率。

# Data Member

下面我们分别讨论 static 和 nonstatic data member 的特点。

## static data member

static data member 在编译过程中会被编译器提出到 class 之外，存储在内存的静态数据区。static data member 被视为一个 global 变量，但仅在 class 的生命范围内可见。对它的存取权限以及与 class 的关联，不会产生任何时间或空间上的额外负担。

每一个 static data member 都只有一个实体，程序的任何调用都只会对这一个实体进行操作。例如：

```cpp
// 通过对象操作
origin.chunkSize = 250;
// 通过类名操作（两者等价）
Point3d::chunkSize = 250;

// 通过指针操作
pt->chunkSize = 250;
// 等价于
Point3d::chunkSize = 250;
```

两种操作方式完全等价，因为 member 并不在 class object 中，对 static data member 的操作根本不需要通过 class object。即使是通过复杂的继承得到的 member，操作方式也不会有什么区别。

### 指向 static data member 的指针

如果你取 static data member 的地址，会得到一个指向其数据类型的普通指针，而不是指向 class member 的指针。

如果你在不同的类中声明了相同名称的 static data member，编译器会暗中对每一个名称进行编码（name-mangling），以获得独一无二的程序内部标识。其具体行为与使用的编译器有关。

## nonstatic data member

nonstatic data member 直接存储在每一个 class object 中。除非通过显式（explicit）或隐式（implicit）的 class object，无法直接存取它们。

所谓 explicit class object 很容易理解：使用实例化的 class object 或指向它的指针，通过 `.` 或 `->` 操作符对 member 进行操作。

而 implicit class object 则是在 member function 中处理 nonstatic data member 时发生，例如：

```cpp
Point3d::translate(const Point3d &pt) {
    x += pt.x;
    y += pt.y;
    z += pt.z;
}
```

表面上是对 `x`、`y` 和 `z` 的直接存取，其实是通过一个 implicit class object（由 this 指针表达）完成的。该函数经过编译器处理后的形式如下：

```cpp
Point3d::translate(Point3d *const this, const Point3d &pt) {
    this->x += pt.x;
    this->y += pt.y;
    this->z += pt.z;
}
```

当你对一个 nonstatic data member 进行存取操作时，编译器需要把 class object 的起始地址加上 data member 的偏移量（offset）。每一个 nonstatic data member 的 offset 在编译期就是可知的，即使它来自一个 base class subobject（派生自单一继承或多重继承链）也一样。因此，存取一个 nonstatic data member 的效率和存取一个 C struct member 或 nonderived class member 是一样的。

## 继承与 Data Member

在 C++ 继承模型中，一个 derived class object 所表现出来的内容，是其自己的 members 加上其所有 base class members 的总和。

继承主要分为单继承、多继承和虚继承，下面分别讨论这三种继承方式对 class object 内存分布的影响。

### 不引入多态的单继承

这种继承方式最简单：derived class object 的内存分布就是 base class members 加上 derived class members。C++ 标准对各个类的 members 在内存中的排列顺序没有做硬性规定，但主流编译器一般是将 base class members 存储在对象内存的前部。

![单继承（无多态）内存布局](/images/现代C++学习/single-inheritance-no-polymorphism.png)

### 不引入多态的多继承

这种继承方式的内存分布与单继承类似，只不过有多个 base class，它们的 members 按照 class 声明的顺序依次排列。

### 虚继承

多继承有时会导致共同的基类被重复继承的问题（菱形继承），从而产生额外的内存开销——对于一个重复的 base class，我们希望它在派生类中只有一个共享的实体。

于是 C++ 引入了**虚继承**（virtual inheritance）。这种继承方式会将共享的 virtual base class 放置在对象内存的尾部，并且在每个 base class subobject 中存储一个**虚基类指针**（vbptr），指向一张**虚基类表**（vbtable）。存取 virtual base class 中的成员时，程序会在运行时先查表获取动态偏移量，再加上当前指针地址来定位。

![虚继承内存布局](/images/现代C++学习/virtual-inheritance-layout.png)

### 指向 nonstatic data member 的指针

与 static data member 不同，指向 nonstatic data member 的指针存储的是 offset（相对偏移量），而不是真正的物理地址。

需要使用 `Class::*` 声明，结合对象通过 `.*` 或 `->*` 进行解引用。例如：

```cpp
float Point3d::*ptr = &Point3d::x;
Point3d obj;
obj.*ptr = 1.0f;
```

`nullptr` 被特殊表示为全 1（即 -1），以区别于合法的偏移量 0。

值得一提的是，空类的大小并不是 0————编译器会在空类中添加一字节的物理空间，以保证空类被实例化后具有独立的地址。同时，C++ 还有 EBO（Empty Base Class Optimization，空基类优化）特性：如果空类作为基类被继承，在现代 C++ 中它占用的这 1 字节会被优化掉（大小算作 0），不占用派生类空间。这一优化自 C++11 起对标准布局类型有明确要求。

# 普通函数成员

## nonstatic function member

由于 C++ 的零成本抽象原则，在设计之初 nonstatic function member 就被要求至少与一般的 nonmember function 具有相同的执行效率。例如：

```cpp
float magnitude3d(const Point3d *_this) {
    return sqrt(_this->x * _this->x
              + _this->y * _this->y
              + _this->z * _this->z);
}

float Point3d::magnitude3d() const {
    return sqrt(x * x + y * y + z * z);
}
```

选择 member function 不应该带来额外的性能负担，这是因为编译器已经将 member function 实体转换为对应的 nonmember function 实体。

虽然乍看之下 nonmember function 似乎更没效率（因为它间接地由外部参数取用坐标，而 member function 可以直接操作），但事实上 member function 会被编译器内化为 nonmember 版本。

转化步骤如下：

1. **安插 this 指针**：改写函数的 signature，在参数列表中插入一个额外的 this 指针，使得 class object 可以调用该函数：

    ```cpp
    // non-const nonstatic member 的增长过程
    float Point3d::magnitude(Point3d *const this);

    // 如果 member function 是 const，则变成：
    float Point3d::magnitude(const Point3d *const this);
    ```

2. **改写 member 存取**：将每一个对 nonstatic data member 的存取操作改为通过 this 指针进行。

3. **Name-mangling**：将 member function 重写成一个外部函数，对函数名进行 mangling 处理，使其成为程序中的唯一符号：

    ```cpp
    extern float _ZN7Point3d9magnitudeEv(Point3d *const this);
    ```

同时，所有的函数调用操作也会被转换：

```cpp
// obj.magnitude();
_ZN7Point3d9magnitudeEv(&obj);
// ptr->magnitude();
_ZN7Point3d9magnitudeEv(ptr);
```

对于函数名的 mangling 处理，不同编译器得到的结果也不同。以上示例为 Itanium ABI 风格的命名。

## static function member

static function member 和 static data member 一样，会在编译过程中被编译器提取到 class 之外，存储在内存的代码区。它被视为一个全局函数，但仅在 class 的生命范围内可见。它不需要经由 class object 才能调用——虽然在语法上通常通过 class object 或类名调用。

由于 static function 没有 this 指针，它不能直接存取 class 中的 nonstatic data member，也不可以被声明为 const、virtual 或 volatile。

## inline function

在代码中，当你把一个函数声明为 `inline` 时，你是在向编译器建议："请在编译阶段，把所有调用这个函数的地方，用函数体直接展开替换，而不是生成真正的函数调用指令。"

如果一个函数非常简短（比如只有一两行代码），且被频繁调用，那么函数调用的压栈、跳转和返回等额外开销，甚至可能远大于函数体内代码本身的执行时间。内联函数的出现，就是为了消除这种微小函数的调用开销。

但是，函数是否会被内联展开，最终决定权在编译器。`inline` 关键字在现代 C++ 中更多地承担链接层面的语义：它告诉链接器，这个函数可能会在多个编译单元中被重复定义，请将它们合并为同一个符号，不要报重定义错误。

此外，在类定义内部直接定义的 member function（包括在 class/struct 内部实现的函数）会被编译器**隐式地视为 inline 函数**，无需显式添加 `inline` 关键字。

# 虚函数与多态

C++ 通过虚函数来实现多态，但引入虚函数后，class object 也会产生额外的开销：

- 引入**虚函数表**（vtbl），用于存放指向虚函数的指针。vtbl 的条目数通常是 virtual function 的数量再加上额外的一两个 slot（用以支持 RTTI）。
- 在每一个 class object 中添加一个指针（vptr），提供执行期的链接，使每一个 object 可以找到对应的 vtbl。
- 加强 constructor 和 destructor，使其能够正确设置和销毁 vptr。

## 多态的概念

在 C++ 中，多态表示用一个 public base class 的指针（或 reference）去寻址一个 derived class object。例如：

```cpp
Point *ptr;
ptr = new Point2d();
```

我们可以用一个 `Point*` 去寻址一个派生类 `Point2d` 的对象。

此时 `ptr` 所展现的多态机能主要是扮演一个输送机制的角色，通过它我们可以在程序的任何地方采用一组 public 派生类型。除了 virtual base class，这种多态形式在编译期就可以被完成————编译器通过 offset 实现指针位置的偏移，让 base 指针指向 derived class object 内部对应的 base class subobject 位置。

但是，当 base class 指针指向的 subobject 被真正使用时（比如调用一个被 derived class 重写的 virtual function），我们需要更多的运行时信息——例如需要知道 derived class object 的真实地址，因为函数调用需要正确的 this 指针。

因此，只要 class 拥有 virtual function，就需要额外的执行期信息来实现多态。这种运行时类型信息称为 RTTI（Run-Time Type Information），它强依赖于虚函数表。不同的继承方式下，object 的内存布局会有所区别。

## 虚函数的调用机制

在 class 内部声明并定义了 virtual function 后，编译器会生成对应的虚函数表（vtbl），内部存储着指向这些函数的指针。同时，class object 的内存中会插入一个 vptr，指向该 class 对应的 vtbl。

当你调用一个虚函数时，编译器会将其转换为类似以下形式：

```cpp
// 转换前
ptr->normalize();
// 转换后（伪代码）
(*ptr->vptr[1])(ptr);
```

编译器根据 vtbl 中指针的顺序来确定索引，并传入 this 指针。

## 单继承下的虚函数

对于单继承，derived class object 和 base class subobject 共享一个 vptr，此时 vtbl 内存放的是指向 base class 和 derived class 的 virtual function 的指针。单继承下，derived class object 中只存储一个 vptr，所有 subobject 共享同一个 vtbl。

![单继承虚函数调用](/images/现代C++学习/single-inheritance-vfunc.png)

如上图所示，无论继承多少次，内存中都只有一个 vptr 和一个 vtbl。当 derived class 重写 base class 的 virtual function 后，vtbl 中对应的函数指针也会更新。如果是 derived class 新增的 virtual function，也会被追加在该 vtbl 中。

此时，无论用 base class 还是 derived class 的指针指向 derived class object，指向的都是同一块内存的首地址（两者地址相同），可以直接通过 vptr 找到 vtbl 并调用 virtual function。

> **关于 vptr 的位置**：在早期的 cfront 编译器中，vptr 被放在对象的尾部；但在现代编译器（如 GCC/Clang 遵循的 Itanium C++ ABI、MSVC）中，为了优化多态调用的寻址效率，vptr 统一被放置在对象内存布局的最前面（offset 0）。下图中 vptr 被放置在 base class subobject 的尾部，这是 cfront 时期的布局方式，请注意与现代编译器的区别。

![单继承带 vptr 内存布局](/images/现代C++学习/single-inheritance-with-vptr.png)

## 多继承下的虚函数

多继承下，derived class object 的内存布局有所不同：内存中存在多个 vptr 和 vtbl。每一个具有 virtual function 的 base class，其 subobject 内部都会有一个 vptr 指向自己的 vtbl。derived class 与位于内存布局头部的第一个 base class 共享同一个 vptr 和 vtbl（因为它们的地址相同）。

![多继承虚函数调用](/images/现代C++学习/multiple-inheritance-vfunc.png)

如上图所示，其中有多个 vptr。之所以需要多个 vptr，是因为多继承时各 base class 指针指向的位置并不相同————除了首地址处的 base class 与 derived class 指针指向同一地址外，其余 base class 指针都指向 object 内存内部的某个偏移处。

此时，当第二个（或更后面的）base class 指针调用 virtual function 时，如果该函数被 derived class 重写，就需要调用 derived class 的 vtbl 中的函数指针，并且必须获取正确的 derived class 的 this 指针。

为了实现这种操作，C++ 使用了 **thunk** 策略：当 derived class 重写 base class 的 virtual function 时，编译器在 base class 的 vtbl 中将对应条目替换为一段 thunk 代码，其作用是先将 this 指针调整到 derived class 的起始位置，再跳转到重写后的函数。

![多继承带 vptr 内存布局](/images/现代C++学习/multiple-inheritance-with-vptr.png)

## 虚继承下的虚函数

在虚继承下，内存布局与多继承还有一些区别：共享的 virtual base class subobject 被放置在 derived class object 内存的尾部。

既然虚基类被放在了内存尾部，其他类想要访问它时需要知道其地址。当前主流的解决方法有两种：

1. 将 offset 嵌入虚表（一般存储在负索引处）。
2. 使用虚基类指针（vbptr），指向一张虚基类表（vbtable）。

![虚继承虚函数调用](/images/现代C++学习/virtual-inheritance-vfunc.png)

## 指向 member function 的指针

与 data member 类似，指向 static member function 的指针直接指向内存中的真实地址。

而指向 nonstatic member function 的指针，由于其运行时需要 this 指针，大小通常是指向 static member function 指针的两倍。内容包括了 function 在内存中的地址以及 this 指针的偏移量，在使用时需要结合类名调用：

```cpp
void (Point3d::*pmf)() = &Point3d::normalize;
Point3d obj;
(obj.*pmf)();
```

指向 virtual member function 的指针，大小通常也是普通函数指针的两倍。由于编译器在编译期并不知道这个指针将来会被哪个具体的派生类对象调用，指针内部需要存储足够的信息，使其能够兼顾普通成员函数与虚函数的调用。在目前的主流实现（如 Itanium ABI）下，指针的第一个字段负责区分虚函数与非虚函数，并存储对应的 vtbl 索引或非虚函数地址；第二个字段存储 this 指针的偏移量。

在多重继承或虚继承下，member function 指针会更加复杂，大小也会更大。

---

这次的插图来自画师 `Aio`

图片地址：https://www.pixiv.net/artworks/131687603

文章内容参考：**深度探索C++对象模型 ([美]Stanley B.Lippman著 侯捷译)** “关于对象”、“data语意学”、“function语意学”章节
