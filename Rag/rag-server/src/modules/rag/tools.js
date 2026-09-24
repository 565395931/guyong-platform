/**
 * LangChain Agent 工具函数集合
 * - robotjs 桌面自动化工具（鼠标、键盘、截图）
 * - 入职管理工具（listNewHires, createAccount, assignSeat）
 * - HITL（Human-in-the-Loop）确认机制：危险工具执行前需用户确认
 */

const fs = require('fs/promises');
const path = require('path');
const { tool } = require('langchain');
const { z } = require('zod');
const { PNG } = require('pngjs');

// ========== robotjs 条件加载 ==========
let robotInstance = null;
let robotLoadError = null;

/**
 * 获取 robotjs 实例（延迟加载）
 * 只有在需要使用桌面自动化功能时才加载
 */
function getRobotInstance() {
  if (robotInstance) return robotInstance;
  if (robotLoadError) throw robotLoadError;

  try {
    robotInstance = require('@jitsi/robotjs');
    console.log('[RobotJS] robotjs 加载成功');
    return robotInstance;
  } catch (error) {
    robotLoadError = error;
    console.error('[RobotJS] robotjs 加载失败:', error.message);
    throw new Error(`robotjs 加载失败: ${error.message}。桌面自动化功能不可用，但其他功能正常。`);
  }
}

// ========== 截图保存目录 ==========
const SCREENSHOT_DIR = path.resolve(process.cwd(), 'screenshots');

// ========== 屏幕尺寸常量（延迟获取）==========
function getScreenSize() {
  try {
    const robot = getRobotInstance();
    return {
      width: robot.getScreenSize().width,
      height: robot.getScreenSize().height
    };
  } catch (error) {
    // 如果 robotjs 无法加载，返回默认值
    return { width: 1920, height: 1080 };
  }
}

// ========== 危险工具名单（需 HITL 认） ==========
const DANGEROUS_TOOLS = new Set([
  'move_mouse',
  'click_mouse',
  'type_text',
  'key_press',
  'scroll_mouse',
  'drag_mouse',
]);

// ========== 工具 1: 移动鼠标 ==========
const moveMouse = tool(
  async ({ x, y, relative }) => {
    try {
      const robot = getRobotInstance();
      const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = getScreenSize();

      const currentPos = robot.getMousePos();
      let targetX, targetY;

      if (relative) {
        targetX = Math.max(0, Math.min(SCREEN_WIDTH, currentPos.x + x));
        targetY = Math.max(0, Math.min(SCREEN_HEIGHT, currentPos.y + y));
      } else {
        targetX = Math.max(0, Math.min(SCREEN_WIDTH, x));
        targetY = Math.max(0, Math.min(SCREEN_HEIGHT, y));
      }

      robot.moveMouse(targetX, targetY);
      const finalPos = robot.getMousePos();
      return `鼠标已移动到 (${finalPos.x}, ${finalPos.y})。`;
    } catch (error) {
      return `移动鼠标失败: ${error.message}`;
    }
  },
  {
    name: 'move_mouse',
    description:
      '移动鼠标到指定坐标。relative 为 true 时相对于当前位置移动, 为 false 时移动到绝对坐标。',
    schema: z.object({
      x: z.number().describe('X 坐标 (绝对或相对)'),
      y: z.number().describe('Y 坐标 (绝对或相对)'),
      relative: z
        .boolean()
        .default(false)
        .describe('是否相对移动，默认 false (绝对坐标)'),
    }),
  }
);

// ========== 工具 2: 点击鼠标 ==========
const clickMouse = tool(
  async ({ button, double }) => {
    try {
      const robot = getRobotInstance();
      const pos = robot.getMousePos();
      if (double) {
        robot.mouseClick(button, true);
        return `已在 (${pos.x}, ${pos.y}) 双击${button === 'right' ? '右键' : '左键'}。`;
      } else {
        robot.mouseClick(button);
        return `已在 (${pos.x}, ${pos.y}) 单击${button === 'right' ? '右键' : '左键'}。`;
      }
    } catch (error) {
      return `点击鼠标失败: ${error.message}`;
    }
  },
  {
    name: 'click_mouse',
    description:
      '在鼠标当前位置点击。button: "left" 左键 / "right" 右键。double: true 为双击。',
    schema: z.object({
      button: z
        .enum(['left', 'right'])
        .default('left')
        .describe('鼠标按键: left 或 right'),
      double: z.boolean().default(false).describe('是否双击，默认 false'),
    }),
  }
);

// ========== 工具 3: 输入文字 ==========
const typeText = tool(
  async ({ text }) => {
    try {
      const robot = getRobotInstance();
      robot.typeString(text);
      return `已输入文字: "${text}"`;
    } catch (error) {
      return `输入文字失败: ${error.message}`;
    }
  },
  {
    name: 'type_text',
    description:
      '在当前焦点窗口/输入框中输入文字。支持英文、数字和标点符号。',
    schema: z.object({
      text: z.string().min(1).max(500).describe('要输入的文本内容'),
    }),
  }
);

// ========== 工具 4: 按键操作 ==========
const keyPress = tool(
  async ({ key, modifiers }) => {
    try {
      const robot = getRobotInstance();
      const mods = modifiers || [];
      if (mods.length > 0) {
        // 按下修饰键
        mods.forEach((m) => robot.keyToggle(m, 'down'));
      }

      robot.keyTap(key);

      if (mods.length > 0) {
        // 释放修饰键
        mods.forEach((m) => robot.keyToggle(m, 'up'));
      }

      const comboStr = mods.length > 0 ? mods.join('+') + '+' + key : key;
      return `已按下: ${comboStr}`;
    } catch (error) {
      return `按键失败: ${error.message}`;
    }
  },
  {
    name: 'key_press',
    description:
      '按下指定按键，可附带修饰键。常用键: enter, escape, tab, space, backspace, delete, home, end, up, down, left, right, f1-f12。修饰键: alt, control, shift。例如 key="c" modifiers=["control"] 即 Ctrl+C。',
    schema: z.object({
      key: z
        .string()
        .describe(
          '按键名称，如 "enter", "escape", "tab", "a", "1", "f1" 等'
        ),
      modifiers: z
        .array(z.enum(['alt', 'control', 'shift', 'command']))
        .optional()
        .describe('修饰键列表，如 ["control"] 表示 Ctrl'),
    }),
  }
);

// ========== 工具 5: 滚动鼠标 ==========
const scrollMouse = tool(
  async ({ direction, clicks }) => {
    try {
      const robot = getRobotInstance();
      const actualClicks = clicks || 3;
      if (direction === 'up') {
        robot.scrollMouse(0, actualClicks);
        return `鼠标已向上滚动 ${actualClicks} 格。`;
      } else if (direction === 'down') {
        robot.scrollMouse(0, -actualClicks);
        return `鼠标已向下滚动 ${actualClicks} 格。`;
      } else {
        return `未知滚动方向: ${direction}，支持 "up" 或 "down"。`;
      }
    } catch (error) {
      return `滚动鼠标失败: ${error.message}`;
    }
  },
  {
    name: 'scroll_mouse',
    description:
      '滚动鼠标滚轮。direction: "up" 向上滚动 / "down" 向下滚动。clicks: 滚动格数。',
    schema: z.object({
      direction: z
        .enum(['up', 'down'])
        .describe('滚动方向: up 或 down'),
      clicks: z.number().default(3).describe('滚动格数，默认 3'),
    }),
  }
);

// ========== 工具 6: 拖拽鼠标 ==========
const dragMouse = tool(
  async ({ fromX, fromY, toX, toY }) => {
    try {
      const robot = getRobotInstance();
      robot.moveMouse(fromX, fromY);
      robot.mouseToggle('down');
      robot.dragMouse(toX, toY);
      robot.mouseToggle('up');
      return `已从 (${fromX}, ${fromY}) 拖拽到 (${toX}, ${toY})。`;
    } catch (error) {
      return `拖拽鼠标失败: ${error.message}`;
    }
  },
  {
    name: 'drag_mouse',
    description: '从起始坐标拖拽到目标坐标。',
    schema: z.object({
      fromX: z.number().describe('起始 X 坐标'),
      fromY: z.number().describe('起始 Y 坐标'),
      toX: z.number().describe('目标 X 坐标'),
      toY: z.number().describe('目标 Y 坐标'),
    }),
  }
);

// ========== 工具 7: 获取鼠标当前位置 ==========
const getMousePos = tool(
  async () => {
    try {
      const robot = getRobotInstance();
      const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = getScreenSize();
      const pos = robot.getMousePos();
      return `鼠标当前位置: (${pos.x}, ${pos.y})。屏幕分辨率: ${SCREEN_WIDTH}x${SCREEN_HEIGHT}。`;
    } catch (error) {
      return `获取鼠标位置失败: ${error.message}`;
    }
  },
  {
    name: 'get_mouse_pos',
    description: '获取鼠标当前坐标位置，以及屏幕分辨率。',
    schema: z.object({}),
  }
);

// ========== 工具 8: 屏幕截图（回传 base64 给 Agent）==========
const takeScreenshot = tool(
  async ({ region, quality }) => {
    try {
      const robot = getRobotInstance();
      const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = getScreenSize();

      // 确保截图目录存在
      await fs.mkdir(SCREENSHOT_DIR, { recursive: true });

      // 计算截图区域
      let x = 0, y = 0, width = SCREEN_WIDTH, height = SCREEN_HEIGHT;
      if (region && region.x !== undefined && region.y !== undefined
        && region.width && region.height) {
        x = Math.max(0, Math.min(SCREEN_WIDTH, region.x));
        y = Math.max(0, Math.min(SCREEN_HEIGHT, region.y));
        width = Math.min(region.width, SCREEN_WIDTH - x);
        height = Math.min(region.height, SCREEN_HEIGHT - y);
      }

      // 截取屏幕原始位图（BGRA）
      const rawCapture = robot.screen.capture(x, y, width, height);

      // BGRA → RGBA PNG
      const png = new PNG({ width, height });
      const rawBuffer = rawCapture.image;
      for (let i = 0; i < width * height; i++) {
        const src = i * 4;
        const dst = i * 4;
        png.data[dst]     = rawBuffer[src + 2]; // B → R
        png.data[dst + 1] = rawBuffer[src + 1]; // G
        png.data[dst + 2] = rawBuffer[src];     // R → B
        png.data[dst + 3] = rawBuffer[src + 3]; // A
      }

      // 编码为 PNG Buffer → base64
      const pngBuffer = PNG.sync.write(png, { compressionLevel: quality || 6 });
      const base64 = pngBuffer.toString('base64');
      const fileSizeKB = (pngBuffer.length / 1024).toFixed(1);

      // 保存到磁盘
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `screenshot_${timestamp}.png`;
      const filepath = path.join(SCREENSHOT_DIR, filename);
      await fs.writeFile(filepath, pngBuffer);

      console.log(`[Screenshot] 已保存: ${filename} (${fileSizeKB} KB) ${width}x${height}`);

      return [
        `截图完成。`,
        `- 文件: ${filename}`,
        `- 尺寸: ${width}x${height}`,
        `- 区域: (${x},${y})`,
        `- 大小: ${fileSizeKB} KB`,
        `- base64 数据长度: ${base64.length} 字符`,
        ``,
        `data:image/png;base64,${base64}`,
      ].join('\n');
    } catch (error) {
      return `截图失败: ${error.message}`;
    }
  },
  {
    name: 'take_screenshot',
    description:
      '截取屏幕并返回 base64 图片数据。' +
      '不传 region 则截全屏。quality: 1-9 PNG压缩等级（默认6）。',
    schema: z.object({
      region: z.object({
        x: z.number().describe('截图区域 X 坐标'),
        y: z.number().describe('截图区域 Y 坐标'),
        width: z.number().describe('截图区域宽度（像素）'),
        height: z.number().describe('截图区域高度（像素）'),
      }).optional().describe('截图区域（可选，不传则全屏）'),
      quality: z.number().min(1).max(9).default(6).describe('PNG 压缩等级 1-9，默认 6'),
    }),
  }
);

// ========== 工具 9: 获取待入职人员名单 ==========
const listNewHires = tool(
  async () => {
    const filePath = path.resolve(process.cwd(), './employees/new_hire_list.csv');
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      return `今日待入职人员名单 (CSV 格式)：\n${data}`;
    } catch (error) {
      return `读取人员名单失败：${error.message}`;
    }
  },
  {
    name: 'list_new_employees',
    description: '获取今日待入职的员工列表。无需参数，直接返回 CSV 格式数据。',
    schema: z.object({}),
  }
);

// ========== 工具 9: 模拟创建账号 ==========
const createAccount = tool(
  async ({ name, email }) => {
    console.log(`✅ [系统执行] 已为 ${name} 创建邮箱: ${email}`);
    return `邮箱 ${email} 创建成功。`;
  },
  {
    name: 'create_email_account',
    description: '为新员工创建公司邮箱账号。',
    schema: z.object({
      name: z.string().describe('员工姓名'),
      email: z.string().describe('生成的邮箱地址'),
    }),
  }
);

// ========== 工具 10: 模拟分配工位 ==========
const assignSeat = tool(
  async ({ name, department, seat }) => {
    console.log(`✅ [系统执行] 已为 ${department} 的 ${name} 分配工位: ${seat}`);
    return `工位 ${seat} 分配成功。`;
  },
  {
    name: 'assign_workstation',
    description: '根据部门和工位编号标准分配工位。',
    schema: z.object({
      name: z.string().describe('员工姓名'),
      department: z.string().describe('所属部门'),
      seat: z.string().describe('符合规范的工位编号，如 A-01'),
    }),
  }
);

// ========== 导出 ==========
const robotTools = [
  moveMouse,
  clickMouse,
  typeText,
  keyPress,
  scrollMouse,
  dragMouse,
  getMousePos,
  takeScreenshot,
];

const hrTools = [listNewHires, createAccount, assignSeat];

const allTools = [...robotTools, ...hrTools];

module.exports = {
  // Robot 桌面自动化工具
  moveMouse,
  clickMouse,
  typeText,
  keyPress,
  scrollMouse,
  dragMouse,
  getMousePos,
  takeScreenshot,
  // HR 入职管理工具
  listNewHires,
  createAccount,
  assignSeat,
  // 工具列表
  robotTools,
  hrTools,
  allTools,
  // HITL 相关
  DANGEROUS_TOOLS,
  // 条件加载辅助函数
  getRobotInstance,
};