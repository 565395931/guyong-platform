---
version: alpha
name: "客服聚合工作台"
description: "面向本地部署客服运营人员的高密度、可信赖蓝色工作台。"
colors:
  primary: "#3B82F6"
  primary-dark: "#2563EB"
  primary-deep: "#1D4ED8"
  success: "#22C55E"
  warning: "#F59E0B"
  danger: "#EF4444"
  background: "#F1F5F9"
  surface: "#FFFFFF"
  text: "#1E293B"
  text-muted: "#64748B"
  border: "#E2E8F0"
typography:
  sans:
    fontFamily: "PingFang SC, Microsoft YaHei, Helvetica Neue, Helvetica, Arial, sans-serif"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace"
rounded:
  sm: "0.25rem"
  md: "0.375rem"
  lg: "0.5rem"
  card: "1rem"
spacing:
  xs: "0.25rem"
  sm: "0.5rem"
  md: "0.75rem"
  lg: "1rem"
  xl: "1.5rem"
components:
  button:
    backgroundColor: "{colors.primary-dark}"
    textColor: "{colors.surface}"
    rounded: "{rounded.md}"
    height: "2.75rem"
  buttonHover:
    backgroundColor: "{colors.primary-deep}"
  focusRing:
    backgroundColor: "{colors.primary}"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    height: "2.75rem"
  mutedText:
    textColor: "{colors.text-muted}"
  divider:
    backgroundColor: "{colors.border}"
  successIndicator:
    backgroundColor: "{colors.success}"
  warningIndicator:
    backgroundColor: "{colors.warning}"
  dangerIndicator:
    backgroundColor: "{colors.danger}"
  workspace:
    backgroundColor: "{colors.background}"
  loginCard: { }
---

# 客服聚合工作台 Design System

## Overview

### Creative North Star

界面参考“本地运营控制台”：状态明确、入口稳定、信息可靠。蓝色代表连接中的渠道与可执行操作，局部使用设备状态和精确标签建立产品识别，不采用营销落地页式的大面积装饰。

### Product context and register

- **Audience and primary job:** 中文客服主管与运营人员，在本机或局域网内管理多平台消息、订单和自动化。
- **Target market(s) and evidence:** 当前为中文本地部署版本；渠道覆盖国内电商与 WhatsApp，不据此推断特定海外市场。
- **Locale(s) and language policy:** 产品界面以简体中文为主，平台专有名词保留官方写法。
- **Usage scene:** 桌面端长时间高频使用；当前产品不包含移动端页面或移动端适配范围。
- **Register:** 产品型工作台；登录与首次初始化保持安静、可信。
- **Memorable signature:** 深蓝连接背景与小型英文设备眉题只用于登录和本机初始化入口。
- **Restraint:** 表单、数据表和业务操作优先采用 Element Plus 已建立的熟悉交互。
- **Anti-references:** 不使用霓虹娱乐风、玻璃拟态堆叠或营销页式大标题，避免削弱企业工具可信度。
- **Token ownership/runtime mapping:** `src/assets/styles/variables.scss` 是运行时规范来源；本文件镜像其语义值，Element Plus 与页面 SCSS 消费这些变量。系统级值变更必须同时更新两处。

## Colors

主操作使用 `primary`，危险、警告和成功只表达对应语义。正文使用 `text`，辅助说明使用 `text-muted`，输入错误不得只依赖颜色。登录背景的深蓝渐变属于认证入口表达，不扩散到数据工作区。

## Typography

中文优先使用苹方和微软雅黑，系统字体回退确保离线部署不依赖网络字体。正文基准不低于 13px，表单标签使用可见的 600 字重；代码、标识符和诊断值使用等宽字体。

## Layout

桌面工作区保持现有高密度布局。认证卡最大宽度 440px。加载、错误和表单状态保持卡片宽度稳定；不以手机端断点作为验收目标。

## Elevation & Depth

工作区以背景、边框和少量阴影区分层级。登录卡允许一次较深投影表达本机入口；常规数据卡禁止重复使用强投影。

## Shapes

基础控件使用 6-8px 圆角，认证卡使用 16px，品牌图标容器可使用 18px。胶囊形状仅用于状态标签，不用于所有按钮。

## Components

### Foundational visual states

所有操作提供默认、悬停、键盘焦点、忙碌、禁用和错误状态。加载期间按钮尺寸不变；错误同时显示文本并与相关字段关联。

### Buttons and actions

主要提交按钮最小高度 44px。危险操作与安全主操作分离，日常动作不使用高强调危险色。

### Navigation and data display

导航按客服工作、业务运营和系统设置分组。单账号模式不显示系统账号管理；服务端仍负责最终授权。

### Forms and overlays

表单使用可见标签、应用内校验、密码管理器语义和内联错误。密码默认遮罩，允许粘贴和浏览器密码管理器填充。

### Iconography

统一使用 Element Plus Icons，图标按钮必须有可访问名称；不使用 emoji 代替功能图标。

### Motion

动效只解释加载与状态变化，遵守 `prefers-reduced-motion`，不在认证流程加入装饰性动画。

### Content and data visualization

文案使用直接动作和具体恢复建议。登录错误不区分“账号不存在”与“密码错误”的视觉权重，敏感值不进入通知或日志。

## Do's and Don'ts

- **Do:** 让本机状态、下一步动作和失败恢复始终清晰。
- **Do:** 复用 Element Plus 表单、消息和图标语义。
- **Don't:** 在交付包内放置万能密码或公开注册入口。
- **Don't:** 用装饰性动画、低对比文字或隐藏标签降低认证可用性。
