// 剧本解析器 — 将 Markdown 剧本转为结构化 JSON

/** 去掉 markdown 强调符与全角标记，仅用于"匹配"，不用于输出 */
function stripMd(s) {
  return String(s || "").replace(/[*_`#＞]/g, "");
}

/**
 * 从角色剧本正文里提取"需要隐瞒的事"。
 *
 * 为什么不能只按固定标题匹配：生成模型对这个小节的写法极不稳定 ——
 * 有时是三级标题，有时是「三、你的任务」下的一个编号条目，有时带 ** 强调符，
 * 有时省略开头的"你"。实测某个剧本 7 个角色里因此漏掉了 5 个的秘密
 * （苏婉娘写成"你需要隐瞒的事"能匹配，沈砚写成"需要隐瞒的事"就匹配不上）。
 * 而秘密丢了会连带毁掉两件事：玩家看不到自己的隐藏信息、AI 玩家演不出隐藏动机。
 *
 * 提取顺序：
 *   1) 独立小节标题（标题本身含"隐瞒/秘密"）
 *   2) 「你的任务」这类列表里，以"隐瞒/秘密"开头的编号条目（含其下的续行）
 *   3) 退化处理：任意一行以该词开头
 *
 * @param {string} text 角色剧本正文
 * @param {number} max 返回长度上限
 * @returns {string} 提取到的秘密；找不到返回空串
 */
function extractSecretFromScript(text, max = 2000) {
  const src = String(text || "");
  if (!src.trim()) return "";
  const clamp = (s) => String(s || "").trim().substring(0, max);
  const NEEDLE = /隐瞒|秘密|隐情/;

  const lines = src.split(/\r?\n/);

  // 1) 独立标题小节
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const isHeading = /^\s*#{2,4}\s/.test(raw);
    if (!isHeading) continue;
    const head = stripMd(raw).replace(/^\s*#{2,4}\s*/, "").trim();
    if (!head || head.length > 40) continue;
    if (!NEEDLE.test(head)) continue;
    const out = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*#{2,4}\s/.test(lines[j])) break; // 下一个标题为止
      out.push(lines[j]);
    }
    const body = out.join("\n").trim();
    if (body) return clamp(body);
  }

  // 2) 编号条目：以"隐瞒/秘密"开头的列表项。
  //    判据是"开头 10 字内出现关键词"而不是枚举措辞 —— 实测模型写过
  //    「你需要隐瞒的事」「需要隐瞒的事」「你必须隐瞒的事」「必须隐瞒的事」四种，
  //    枚举永远会漏。用"开头 10 字"而不是"整行包含"，是为了避免误吞
  //    「开场交代：…（可选择性隐瞒）」这种顺带一提的条目。
  const itemStart = /^\s*(\d+)[.、]\s*/;
  for (let i = 0; i < lines.length; i++) {
    if (!itemStart.test(lines[i])) continue;
    const headCore = stripMd(lines[i]).replace(itemStart, "").trim();
    if (!NEEDLE.test(headCore.slice(0, 10))) continue;
    const out = [headCore];
    // 收集该条目下的续行（直到下一个编号条目）
    for (let j = i + 1; j < lines.length; j++) {
      if (itemStart.test(lines[j])) break;
      out.push(lines[j]);
    }
    const body = out.join("\n").trim();
    if (body) return clamp(body);
  }

  // 3) 退化：任意一行开头就带关键词（例如未参与编号的 "**需要隐瞒的事**：…"）
  for (const raw of lines) {
    const t = stripMd(raw).trim();
    if (NEEDLE.test(t.slice(0, 10))) return clamp(t);
  }
  return "";
}

/**
 * 从角色标题里取出"人名本体"，切掉跟在后面的说明文字。
 *
 * 生成模型写标题很不稳定，实测同时存在过：
 *   "### 玩家角色 2：玛格丽特·伦诺克斯"          ← 正常
 *   "### 玩家角色 1：格雷（男，35岁，庄园管家）"    ← 名字后面跟说明
 *   "### NPC 1：薇拉·哈罗兰 [凶手]"                ← 方括号身份后缀
 * 直接把整段当名字，会因为"太长"被判非法而整条丢掉（见 isValidCharacterName）。
 *
 * 切点取第一个全/半角括号、顿号、逗号、分号、竖线、冒号 —— 中文人名不会出现这些字符。
 *
 * @param {string} raw 标题捕获到的原始文本
 * @returns {string} 人名本体（已去空格与方括号后缀）
 */
function cutCharacterName(raw) {
  let s = String(raw || "").trim();
  s = s.replace(/\s*\[[^\]]*\]\s*$/, "").trim();   // [凶手] 这类方括号后缀
  s = s.replace(/\s*【[^】]*】\s*$/, "").trim();    // 【凶手】全角后缀
  s = s.split(/[（(，,、；;｜|：:【]/)[0].trim();  // 说明文字
  return s;
}

/**
 * 这是个人名吗？
 *
 * ⚠️ **上限从 6 字放宽到 12 字是实测修出来的**：
 *   某剧本生成阶段写好了 4 玩家 + 3 NPC，切分却只剩 3 玩家 + 2 NPC ——
 *   丢的是 `玛格丽特·伦诺克斯`（9 字）和 `科尔姆·布莱斯`（7 字），
 *   正好卡在旧的 `name.length > 6` 这一刀上。被丢的角色在游戏里**根本不存在**
 *   （选角选不到、AI 补位补不上、DM 时间线却还在讲他），比"名字难看"严重得多。
 *
 * 6 字上限本来想防的是"把说明文字当名字"，那件事应该交给 cutCharacterName 去切，
 * 而不是连真名字一起丢。
 *
 * @param {string} name 已经过 cutCharacterName 的名字
 */
function isValidCharacterName(name) {
  if (!name || name.length < 2 || name.length > 12) return false;
  // 说明性标点混进来了 → 这不是名字本体（调用方应先过 cutCharacterName）。
  // 中间点 `·` 是名字的一部分，必须放行；括号/逗号/顿号/竖线/冒号/方括号都属于说明文字。
  if (/[（)），,、；;｜|：:[\]【】]/.test(name)) return false;
  // 含这些词的"名字"其实是占位符或说明文字（如"玩家角色3：凶手"）
  if (/凶手|死者|角色|未知|年龄|性别|嫌疑人/.test(name)) return false;
  return true;
}

/**
 * 体检：markdown 里的角色标题有几个，解析器认出了几个。
 *
 * 存在理由：这类丢人是**静默**的 —— 标题有 7 个、解析出 5 个，流程一路绿灯，
 * 直到"切分完成：3玩家+2NPC"才在日志里露出来（起因是名字长度上限）。
 * 只要有角色从标题里消失，就该当场喊出来，而不是等到有人对不上人数。
 *
 * @param {string} markdown 剧本原文
 * @param {Array}  characters parseScript 的输出
 * @returns {{headingCount:number, parsedCount:number, dropped:number}}
 */
function checkCharacterCoverage(markdown, characters) {
  const headings = String(markdown || "").match(/^#{1,4}\s*(?:玩家角色|NPC)\s*\d+/gm) || [];
  const parsed = (characters || []).length;
  return { headingCount: headings.length, parsedCount: parsed, dropped: Math.max(0, headings.length - parsed) };
}

function parseScript(markdown) {
  const result = {
    title: "",
    setting: {},
    victim: {},
    characters: [],
    murderer: {},
    clues: { round1: [], round2: [], round3: [], redHerrings: [] },
    dmGuide: {},
    layoutDescription: "",
    errors: [],
  };

  try {
    // === 标题 ===
    let titleMatch = markdown.match(/^#\s*《(.+?)》/m);
    // 有书名号的格式（优先，排除"剧本杀完整剧本"等组装标题）
    if (!titleMatch) titleMatch = markdown.match(/\*\*剧本名称\*\*[：:]\s*《?(.+?)》?/);
    if (!titleMatch) titleMatch = markdown.match(/剧本名称[：:]\s*《?(.+?)》?/);
    // 无书名号的格式
    if (!titleMatch) titleMatch = markdown.match(/\*\*剧本名称\*\*[：:]\s*(.+)/);
    if (!titleMatch) titleMatch = markdown.match(/剧本名称[：:]\s*(.+)/);
    // 最后尝试：第一个#标题（排除"剧本杀完整剧本"）
    if (!titleMatch) {
      const h1Match = markdown.match(/^#\s*(?!剧本杀完整剧本)(.+)/m);
      if (h1Match) titleMatch = h1Match;
    }
    result.title = titleMatch ? titleMatch[1].trim() : "未命名剧本";

    // === 基本设定 ===
    result.setting = {
      era: extractField(markdown, "时代背景"),
      location: extractField(markdown, "地点场景"),
      playerCount: extractField(markdown, "参与人数"),
      duration: extractField(markdown, "游戏时长"),
      difficulty: extractField(markdown, "难度等级"),
      gameMode: extractGameMode(markdown),
    };

    // === 死者信息 ===
    result.victim = {
      name: extractField(markdown, "姓名与身份"),
      deathTime: extractField(markdown, "死亡时间"),
      deathPlace: extractField(markdown, "死亡地点"),
      causeOfDeath: extractField(markdown, "直接死因"),
      bodyDescription: extractSection(markdown, "尸体状态"),
      fullSection: extractSection(markdown, "死者信息", 1500),
    };

    // === 凶手设定 ===
    const murdererSection = extractSection(markdown, "凶手设定", 3000);
    result.murderer = {
      name: extractField(murdererSection, "凶手姓名") || extractField(markdown, "凶手姓名"),
      motive: extractField(murdererSection, "作案动机") || extractSection(markdown, "作案动机", 1000),
      method: extractField(murdererSection, "作案手法") || extractSection(markdown, "作案手法", 1500),
      feasibility: extractSection(markdown, "可行性", 500),
      mistakes: extractSection(markdown, "破绽与线索", 800),
    };

    // === 角色列表（从角色设定表格） ===
    result.characters = extractCharacters(markdown, result.murderer.name);
    if (result.characters.length < 2) {
      result.errors.push("角色提取数量不足，可能影响游戏");
    }

    // === 角色个人剧本 ===
    extractCharacterScripts(markdown, result.characters);

    // === 线索系统 ===
    result.clues = extractAllClues(markdown);

    // === DM 手册 ===
    result.dmGuide = {
      openingMonologue: extractSection(markdown, "DM开场白", 2000),
      fullTimeline: extractSection(markdown, "完整时间线", 3000),
      // 3000 → 12000：真本的真相复盘能到 1.1 万字（《吉普赛女郎之死》11242 字），
    // 原来 3000 字的上限会把长复盘**从中间截断**，而且截断后没有任何提示。
    truthReveal: extractSection(markdown, "真相复盘", 12000),
      endings: {
        trueEnding: extractSection(markdown, "真结局", 500),
        escapeEnding: extractSection(markdown, "凶手逃脱", 500),
        wrongEnding: extractSection(markdown, "误判", 500),
      },
    };

    // === 场景布局（多模式提取） ===
    result.layoutDescription =
      extractSection(markdown, "场景布局", 3000)
      || extractSection(markdown, "场景布局图", 3000)
      || extractSection(markdown, "平面布局", 3000)
      || extractSection(markdown, "房间布局", 3000)
      || extractSection(markdown, "场景地图", 3000)
      || extractSection(markdown, "房间位置描述", 3000)
      || extractSection(markdown, "地图", 3000)
      || extractField(markdown, "布局")
      || extractField(markdown, "场景")
      || "";

  } catch (e) {
    result.errors.push("解析异常: " + e.message);
  }

  return result;
}

// ==================== 工具函数 ====================

function extractField(text, label) {
  // 兼容 CRLF（\r\n）与 LF（\n）；\s*? 非贪婪避免吞掉行尾换行
  //
  // ⚠️ 但 `\s*?` **能跨换行**，于是"值为空"的字段会把**下一行**当成自己的值。
  // 实测（真跑出来的两本稿都有）：`- **死亡时间**：` 后面是空的，解析器就把下一行
  // `- **死亡地点**：放映室` 整个吞成 deathTime → `victim.deathTime = "**死亡地点**：放映室"`。
  // 这串垃圾会顺着 ai-player-llm 念给 AI 玩家（"死亡时间 **死亡地点**：放映室"），
  // 比字段为空更糟 —— 空至少是"不知道"，这是"知道错了"。
  // 修法：加负向前瞻，**只拒绝"下一行本身是另一个字段"**这种情况 ——
  // 既要认加粗形态（`- **死亡地点**：`），也要认不加粗形态（`- 死亡地点：`）。
  // 不能简单把 \s*? 换成 [ \t]*，因为"值另起一段"是合法写法（如 `- **尸体状态**：\n<整段描述>`），
  // 那样改会把这类字段一律读成空。
  // 三种模式都要加：第三种带 `s` 标志、本来就能跨行，不加就绕过去了（单测抓到过）。
  // ⚠️ "字段行"的判据必须收紧到**中文字标签 + 冒号**（`[一-龥]{1,12}[：:]`），
  // 不能写成"短串+冒号" —— 那样会把**值**也误判成字段行：实测 `- **死亡时间**：22:28`
  // 里的 `22:28` 会被当成"标签 22 + 冒号"，于是这个值被读成空（单测当场抓到）。
  // 代价：值另起一段、且首行以"某某："开头的散文会被读成空；这种写法在本项目不存在
  //（字段值要么同行、要么是整段叙述），两害相权取"不再污染结构化数据"。
  const NOT_A_FIELD = "(?!\\s*[-*]?\\s*(?:\\*\\*|[\\u4e00-\\u9fa5]{1,12}[：:]))";
  const patterns = [
    new RegExp(`${label}[：:]\\s*?${NOT_A_FIELD}(.+?)(?:\\r?\\n|$)`, "i"),
    new RegExp(`\\*\\*${label}\\*\\*[：:]\\s*?${NOT_A_FIELD}(.+?)(?:\\r?\\n|$)`, "i"),
    new RegExp(`${label}\\s*[：:]\\s*?${NOT_A_FIELD}(.+?)(?:\\r?\\n\\r?\\n|\\r?\\n#{1,3}|$)`, "is"),
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1].trim().replace(/^[-*]\s*/, "");
  }
  return "";
}

/** 从剧本中识别游戏模式：PVE（侦探对抗/NPC嫌疑人） / PVP（玩家互疑） */
function extractGameMode(markdown) {
  const field = extractField(markdown, "游戏模式");
  if (!field) return "";
  const f = String(field).toLowerCase();
  if (f.includes("pvp") || f.includes("玩家互疑") || f.includes("玩家对抗")) return "PVP";
  return "PVE"; // PVE / 侦探对抗 / 混合 均归 PVE
}

function extractSection(text, heading, maxLen = 2000) {
  const t = String(text || "");
  if (!t) return "";
  const lines = t.split("\n");
  // 1) 找到**第一处包含该标题词的行**（标题行常带序号，如 `### 四、真相复盘`，
  //    所以不能要求行首直接是标题词 —— 第一版就是这么写的，导致一律返回空串）
  let lineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(heading)) { lineIdx = i; break; }
  }
  if (lineIdx < 0) return "";
  const hm = lines[lineIdx].match(/^(#{1,4})\s+/);
  const level = hm ? hm[1].length : 0;

  // 2) 正文起点 = 标题行之后
  let offset = 0;
  for (let i = 0; i <= lineIdx; i++) offset += lines[i].length + 1;
  const startIdx = Math.min(offset, t.length);

  // 3) 边界：后面第一个**层级不深于本节**的标题行；
  //    绝不能按"第X""一、"这类字样判边界 —— 实测 `#### 第一轮线索` 会命中，
  //    于是 27000 字的成稿里「真相复盘」只被抠出 718 字（长复盘被静默丢掉）。
  let endIdx = t.length;
  if (level > 0) {
    let off = startIdx;
    for (let i = lineIdx + 1; i < lines.length; i++) {
      const m = lines[i].match(/^(#{1,4})\s+\S/);
      if (m && m[1].length <= level) { endIdx = off; break; }
      off += lines[i].length + 1;
    }
  } else {
    const rest = t.slice(startIdx);
    const stop = rest.search(/\n#{1,4}\s+[一二三四五六七八九十\d]+[、.．]/);
    if (stop >= 0) endIdx = startIdx + stop;
  }

  let content = t.slice(startIdx, endIdx).trim();
  content = content.replace(/^[-—]{3,}\s*$/m, "").trim();
  if (content.length > maxLen) content = content.substring(0, maxLen) + "...";
  return content;
}

function extractCharacters(text, murdererName) {
  const chars = [];

  // 方法A: 匹配多种角色标题格式
  // 格式1: "### 玩家角色 X：姓名" 或 "### 玩家角色X：姓名"
  // 格式2: "### NPC X：姓名" 或 "### NPCX：姓名"
  // 格式3: "### 角色 X：姓名"（旧格式，兼容）
  const headingPatterns = [
    { regex: /^###\s*玩家角色\s*[一二三四五六七八\d]+\s*[：:]\s*(.+?)(?:\s*\[.*?\])?\s*$/gm, type: "player" },
    { regex: /^###\s*NPC\s*[一二三四五六七八\d]+\s*[：:]\s*(.+?)(?:\s*\[.*?\])?\s*$/gm, type: "npc" },
    { regex: /^###\s*角色\s*[一二三四五六七八\d]+\s*[：:]\s*(.+?)(?:\s*\[.*?\])?\s*$/gm, type: null }, // 旧格式
  ];

  for (const { regex, type } of headingPatterns) {
    let match;
    while ((match = regex.exec(text)) !== null) {
      // 先切掉名字后面的说明文字，再判"是不是人名"。
      // 旧版直接按 2~6 字判，把 `玛格丽特·伦诺克斯`（9 字）`科尔姆·布莱斯`（7 字）整条丢掉。
      const name = cutCharacterName(match[1]);
      if (!isValidCharacterName(name)) continue;
      // 避免重复
      if (chars.find(c => c.name === name)) continue;

      let roleType = type;
      if (roleType === null) {
        // 旧格式：在上下文中检测NPC/player标记
        const blockStart = match.index;
        const nextBlock = text.indexOf("\n###", blockStart + 1);
        const block = text.substring(blockStart, nextBlock > 0 ? nextBlock : blockStart + 2000);
        const isNPC = /【NPC】|NPC嫌疑人/.test(block);
        const isPlayer = /【玩家】|玩家角色/.test(block);
        roleType = isNPC ? "npc" : isPlayer ? "player" : "player";
      }

      // 在角色块中检测凶手标记和职业
      const blockStart = match.index;
      const nextBlock = text.indexOf("\n###", blockStart + 1);
      const block = text.substring(blockStart, nextBlock > 0 ? nextBlock : blockStart + 2000);
      const isMurderer = /\[凶手\]|凶手/.test(block.substring(0, 100));
      // 终止符含 ｜：assembleScript 把身份/语气/个人任务写成同一行的
      // "> 职业/身份：X ｜ 语气：Y ｜ 个人任务：Z"，只按换行截断会把整行都吞进去。
      const END = "(?:\\s*｜|\\n|$)";
      const occMatch = block.match(new RegExp("(?:职业\\/身份|职业|身份)[：:]\\s*(.+?)" + END));
      const occupation = occMatch ? occMatch[1].trim() : "";
      const personaMatch = block.match(new RegExp("语气[：:]\\s*(.+?)" + END));
      const goalMatch = block.match(new RegExp("个人任务[：:]\\s*(.+?)" + END));

      chars.push({
        name, age: "", gender: "", occupation,
        personality: personaMatch ? personaMatch[1].trim() : "",
        goal: goalMatch ? goalMatch[1].trim() : "",
        relationshipToVictim: "", isMurderer,
        roleType,
      });
    }
  }

  // 方法B: 匹配 "- **姓名**：xxx" 格式（fallback）
  if (chars.length === 0) {
    const section = extractSection(text, "角色设定", 10000);
    const lines = section.split("\n");
    let currentChar = null;

    for (const line of lines) {
      const nameMatch = line.match(/[-*]\s*\*\*姓名\*\*[：:]\s*(.{1,40})/);
      if (nameMatch) {
        const name = cutCharacterName(nameMatch[1].replace(/\*+/g, ""));
        if (isValidCharacterName(name)) {
          currentChar = { name, age: "", gender: "", occupation: "", personality: "", relationshipToVictim: "", isMurderer: false };
          chars.push(currentChar);
        }
        continue;
      }
      if (currentChar) {
        const occMatch = line.match(/\*\*职业\/?身份\*\*[：:]\s*(.+)/);
        if (occMatch) currentChar.occupation = occMatch[1].trim();
        const relMatch = line.match(/\*\*与死者关系\*\*[：:]\s*(.+)/);
        if (relMatch) currentChar.relationshipToVictim = relMatch[1].trim();
        const ageMatch = line.match(/\*\*年龄\/?性别\*\*[：:]\s*(.+)/);
        if (ageMatch) currentChar.age = ageMatch[1].trim();
      }
    }
  }

  // 方法C: 查找所有 "### 角色" 标题
  if (chars.length === 0) {
    const roleHeadings = text.match(/^#{2,4}\s*角色[：:、\s].+$/gm);
    if (roleHeadings) {
      roleHeadings.forEach(h => {
        const nameMatch = h.match(/角色[：:、\s]*(.{1,40})$/);
        if (nameMatch) {
          const n = cutCharacterName(nameMatch[1]);
          if (isValidCharacterName(n)) chars.push({ name: n, age: "", gender: "", occupation: "", personality: "", relationshipToVictim: "", isMurderer: false });
        }
      });
    }
  }

  // 标记凶手
  if (murdererName) {
    chars.forEach(c => {
      if (c.name === murdererName || murdererName.includes(c.name) || c.name.includes(murdererName)) {
        c.isMurderer = true;
      }
    });
  }

  return chars;
}

function extractCharacterScripts(markdown, characters) {
  // 按角色类型和名字找到剧本段落
  // assembleScript格式: ### 玩家角色N：姓名 或 ### NPC N：姓名
  for (let idx = 0; idx < characters.length; idx++) {
    const char = characters[idx];
    const escapedName = escapeRegex(char.name);
    const typePrefix = char.roleType === "npc" ? "NPC" : "玩家角色";

    // 精确匹配：### NPC N：姓名 或 ### 玩家角色 N：姓名，允许[凶手]后缀
    const headingPattern = `#{2,4}\\s*(?:${typePrefix}|角色)\\s*\\d+[：:]\\s*${escapedName}(?:\\s*\\[.*?\\])?\\s*\\n`;
    const headingRegex = new RegExp(headingPattern, "i");
    const headingMatch = markdown.match(headingRegex);

    if (!headingMatch) continue;

    const startIdx = headingMatch.index + headingMatch[0].length;
    let endIdx = markdown.length;

    // 找到下一个角色标题或章节标题作为结束（而非内部##子标题）
    const nextRoleOrSection = markdown.substring(startIdx).match(
      /\n(?:#{1,4}\s*(?:玩家角色|NPC|角色)\s*\d+[：:]|#{1,3}\s*(?:玩家角色剧本|NPC嫌疑人信息|NPC目击者\/关系人信息|线索系统|DM\s*手册|证据链|场景布局|第[一二三四五六七八九十]、|第[一二三四五六七八九十]部分))/i
    );
    if (nextRoleOrSection) {
      endIdx = startIdx + nextRoleOrSection.index;
    }

    let section = markdown.substring(startIdx, endIdx);
    section = headingMatch[0] + section;

    // 根据角色类型提取不同字段
    const isNpc = char.roleType === "npc";
    const isPlayer = char.roleType === "player" || !isNpc;

    if (isNpc) {
      // NPC：提取关系、动机、时间线、隐瞒/可供审讯信息
      char.script = {
        story: extractSection(section, "人物关系", 4000) || extractSection(section, "背景故事", 4000) || section.substring(0, 4000),
        secret: extractSecretFromScript(section) || extractSection(section, "需要隐瞒", 2000) || extractSection(section, "秘密", 2000),
        motive: extractSection(section, "作案动机", 2000),
        personalTimeline: extractSection(section, "时间线", 5000),
        items: extractSection(section, "可供审讯透露", 2000) || extractSection(section, "相关物品", 2000),
        method: extractSection(section, "凶手确认", 5000) || extractSection(section, "作案过程", 5000),
        fullScript: section.substring(0, 12000),
      };
    } else {
      char.script = {
        story: extractSection(section, "你的背景故事", 5000) || extractField(section, "你的身份") || extractSection(section, "你的身份", 4000) || extractField(section, "案发背景") || extractSection(section, "案发背景", 4000) || extractField(section, "你的故事") || extractSection(section, "你的故事", 4000) || extractSection(section, "背景故事", 4000),
        secret: extractSecretFromScript(section) || extractSection(section, "你需要隐瞒的事", 2000) || extractField(section, "你要隐瞒的") || extractSection(section, "你要隐瞒的", 2000) || extractField(section, "你的秘密") || extractSection(section, "你的秘密", 2000) || extractField(section, "秘密"),
        personalTimeline: extractSection(section, "你的时间线", 3000) || extractSection(section, "时间线", 3000),
        motive: extractSection(section, "你的杀机", 2000) || extractSection(section, "作案动机", 2000),
        goals: extractSection(section, "你的任务", 2000) || extractSection(section, "调查目标", 2000) || extractField(section, "你要查明的") || extractSection(section, "你要查明的", 2000) || extractSection(section, "你需要查明或隐瞒的事", 2000),
        knownInfo: extractSection(section, "你掌握的信息", 3000) || extractSection(section, "你已知晓的事情", 3000) || extractSection(section, "初步信息", 3000),
        items: extractSection(section, "你的物品", 2000) || extractSection(section, "你随身携带的物品", 2000) || extractSection(section, "物品", 2000),
        fullScript: section.substring(0, 10000),
      };
    }
  }
}

function extractAllClues(markdown) {
  const rounds = { round1: [], round2: [], round3: [], redHerrings: [] };

  // Find the clues section
  // 注意：不能用 extractSection（其 lookahead 把 "## 第一轮线索" 之类的行
  // 误判为新章节而提前截断），直接从原文按位置切分，直到"第四部分"或文件末尾。
  let clueSection = "";
  const clueIdx = markdown.search(/(?:线索系统|完整线索|第三部分)/i);
  if (clueIdx >= 0) {
    const endIdx = markdown.indexOf("# 第四部分", clueIdx);
    const endIdx2 = markdown.indexOf("\n# 第四部分", clueIdx);
    const end = Math.min(
      endIdx >= 0 ? endIdx : Infinity,
      endIdx2 >= 0 ? endIdx2 : Infinity,
      markdown.length
    );
    clueSection = markdown.substring(clueIdx, Math.min(end, clueIdx + 60000));
  }

  // Split into round sections by ## 第X轮 headings
  const roundPattern = /##\s*第([一二三])轮/g;
  const roundMatches = [];
  let m;
  while ((m = roundPattern.exec(clueSection)) !== null) {
    roundMatches.push({ round: m[1], start: m.index });
  }

  for (let i = 0; i < roundMatches.length; i++) {
    const { round, start } = roundMatches[i];
    const end = i + 1 < roundMatches.length ? roundMatches[i + 1].start : clueSection.length;
    const sectionText = clueSection.substring(start, end);

    const prefix = round === "一" ? "A" : round === "二" ? "B" : "C";
    const roundNum = round === "一" ? 1 : round === "二" ? 2 : 3;
    const key = `round${roundNum}`;

    rounds[key] = parseClueSection(sectionText, prefix, roundNum);
  }

  // Also try splitting on ### sections directly as fallback
  // 兼容两轮制：即使没有 "## 第X轮" 标题，也按线索 ID 前缀推断轮次
  // （A→第一轮，B/C→第二轮，M→与其附近的轮保持一致，这里统一归入第二轮避免提前剧透）
  const allClues = [...rounds.round1, ...rounds.round2, ...rounds.round3];
  if (allClues.length === 0) {
    const rawClues = parseClueSection(clueSection, "A", 1);
    rounds.round1 = rawClues.filter(c => /^A\d+$/.test(c.id));
    rounds.round2 = rawClues.filter(c => /^(B|C|M)\d+$/.test(c.id)).map(c => ({ ...c, round: 2 }));
    rounds.round3 = [];
  }

  return rounds;
}

function parseClueSection(text, prefix, roundNum) {
  const clues = [];
  if (!text) return clues;
  // Split by "### Xn：" headings (A/B/C/M prefix)
  const clueBlocks = text.split(/\n(?=###\s+[A-CM]\d+[：:\s])/);

  for (const block of clueBlocks) {
    // Extract clue ID: match "### A1" or "### A1："
    const idMatch = block.match(/^###\s+([A-CM]\d+)/m);
    if (!idMatch) continue;

    const id = idMatch[1];
    const roundForClue = id.startsWith("M") ? roundNum : roundNum; // 误导线索归入当前轮
    const clue = {
      id, round: roundForClue, content: "", pointsTo: "", clueType: "", location: "",
      hiddenContent: "",     // 我们自家格式：同一线索块内的 `- 隐藏线索：…`
      diggable: false,       // 真本格式：正文标「（发现隐藏线索，可深入调查）」
      hiddenBehind: "",      // 真本格式：正文标「（通过深入调查 A6「…」获取）」→ 挖 A6 才拿到
    };

    // 逐行解析字段（兼容 **加粗** 与 普通 两种标签格式）
    // 字段行："- 线索类型：xxx" / "- **发现地点**：xxx" 等
    const fieldLine = /^\s*[-*]\s*(?:\*\*)?(线索类型|发现地点|线索内容|指向角色\/?事件|隐藏线索)(?:\*\*)?[：:]\s*(.+)\s*$/;
    let pendingContent = null; // 遇到"线索内容"行后，把后续非字段行拼进来（支持多行内容）
    for (const line of block.split("\n")) {
      const fm = line.match(fieldLine);
      if (fm) {
        if (fm[1] === "线索类型") clue.clueType = fm[2].trim();
        else if (fm[1] === "发现地点") clue.location = fm[2].trim();
        else if (fm[1] === "线索内容") { clue.content = fm[2].trim(); pendingContent = true; }
        // 隐藏线索：需要玩家额外「深入调查」才拿到（真本 45 条里有 8 条）
        else if (fm[1] === "隐藏线索") { clue.hiddenContent = fm[2].trim(); pendingContent = "hidden"; }
        else if (fm[1] === "指向角色" || fm[1] === "指向角色/事件") clue.pointsTo = fm[2].trim();
      } else if (pendingContent) {
        const t = line.trim();
        // 续行终止条件：空行 / "---"分隔线 / "#标题" / "|"表格行（防止把后续章节如"推理链总结"吞进线索内容）
        if (!t || t === "---" || /^#{1,6}\s/.test(t) || /^\|/.test(t) || /^[-*]\s*(?:线索类型|发现地点|线索内容|指向角色\/?事件|隐藏线索)/.test(t)) {
          pendingContent = null;
        } else if (pendingContent === "hidden") {
          clue.hiddenContent += " " + t;
        } else {
          clue.content += " " + t;
        }
      }
    }

    // If content is still empty, take the entire body
    if (!clue.content) {
      const bodyMatch = block.match(/^###\s+[A-CM]\d+[：:\s]*[^\n]*\n([\s\S]+)/);
      if (bodyMatch) {
        clue.content = bodyMatch[1].trim().substring(0, 500);
      }
    }

    // ===== 真本格式的隐藏线索标记（2026-10-18 核对 344 原文后补上）=====
    // 真本的写法不是在块里加字段，而是：
    //   父线索：口袋里有一只空瓶。（发现隐藏线索，可深入调查）
    //   子线索：瓶壁上残留着微量红色粉末 （通过深入调查 A6「口袋里有一只空瓶。」获取）
    // 子线索是**独立编号**的一条线索（344 共 45 条 = 37 普通 + 8 隐藏），
    // 平时不在搜证池里，只有对父线索做「深入调查」才拿到。
    {
      const whole = `${clue.content || ""}`;
      if (/（\s*发现隐藏线索\s*[，,]?\s*可深入调查\s*）/.test(whole)
        || /发现隐藏线索/.test(whole)) {
        clue.diggable = true;
      }
      const behind = whole.match(/（\s*通过深入调查\s*([A-CM]\d{1,3})/);
      if (behind) clue.hiddenBehind = behind[1];
    }

    if (clue.content || clue.pointsTo) clues.push(clue);
  }

  // Fallback: match "- **线索内容**" / "- 线索内容" directly
  if (clues.length === 0) {
    const lines = text.split("\n");
    let current = null;
    for (const line of lines) {
      const bidMatch = line.match(/^[-*]\s*(?:\*\*)?线索内容(?:\*\*)?[：:]\s*(.+)/);
      if (bidMatch) {
        if (current) clues.push(current);
        current = { id: `${prefix}${clues.length + 1}`, round: roundNum, content: bidMatch[1].trim(), pointsTo: "", clueType: "" };
        continue;
      }
      if (current) {
        const pm = line.match(/^[-*]\s*(?:\*\*)?指向角色\/?事件(?:\*\*)?[：:]\s*(.+)/);
        if (pm) { current.pointsTo = pm[1].trim(); continue; }
        const tm = line.match(/^[-*]\s*(?:\*\*)?线索类型(?:\*\*)?[：:]\s*(.+)/);
        if (tm) { current.clueType = tm[1].trim(); continue; }
        const lm = line.match(/^[-*]\s*(?:\*\*)?发现地点(?:\*\*)?[：:]\s*(.+)/);
        if (lm) { current.location = lm[1].trim(); continue; }
      }
    }
    if (current) clues.push(current);
  }

  return clues;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 把角色的 script 字段归一化成纯文本 + 秘密。
 *
 * 为什么需要这个函数：角色的 script 在不同来源下形态不一致，历史上踩过坑——
 *   1) parseScript() 产出的是对象：{ story, secret, personalTimeline, fullScript, ... }
 *   2) game-room-creator 的 split 路径产出的是对象：{ story: <playerScript>, secret }
 *   3) 也存在直接用字符串的写法（旧数据 / 手工构造）
 * 调用方若写 `script: char.script || ""`，第 1、2 种会拿到对象，拼进字符串就变成
 * "[object Object]"（玩家端"阅读剧本"整页都是这个）。同一处还会漏掉秘密，
 * 因为 split 路径下秘密在 char.script.secret，而 char.secret 是 undefined。
 *
 * 取正文时优先 fullScript 再 story，与 script-splitter 保存剧本时的口径保持一致，
 * 否则同一个角色在"保存时"和"阅读时"看到的正文范围会不一样。
 *
 * @param {object} char 解析出的角色对象
 * @returns {{script: string, secret: string}}
 */
function normalizeCharacterScript(char) {
  if (!char) return { script: "", secret: "" };
  const raw = char.script;
  let text = "";
  let secret = "";
  if (typeof raw === "string") {
    text = raw;
  } else if (raw && typeof raw === "object") {
    text = raw.fullScript || raw.story || raw.playerScript || "";
    secret = raw.secret || "";
  }
  if (!text && typeof char.playerScript === "string") text = char.playerScript;
  if (!secret && typeof char.secret === "string") secret = char.secret;
  const script = String(text || "");
  // 秘密兜底：早期解析只认固定标题「你需要隐瞒的事」，模型换个措辞（"需要隐瞒的事"等）
  // 就会漏掉 —— 实测某剧本 7 个角色漏了 5 个。这里在读取时从正文再提取一次，
  // 让【已经生成并存库的旧剧本】也能恢复秘密，不必重新生成。
  if (!secret && script) secret = extractSecretFromScript(script, 1200);
  return { script, secret: String(secret || "") };
}

// extractAllClues 一并导出：可观测性补写要把新线索插进正确的轮次区间，
// 而"插对了没有"只有真实解析器能回答——测试直接用它校验，而不是断言字符串位置。
// cutCharacterName / isValidCharacterName 一并导出：生成链路（murder-mystery-builder）
// 提角色名单时踩的是同一个坑（2~6 / 2~8 字上限），必须共用同一份判据，
// 否则"生成时算出来的名单"和"切分时解析出的名单"会长得不一样，两边各修各的就会复发。
module.exports = {
  parseScript, normalizeCharacterScript, extractSecretFromScript, extractAllClues, extractSection,
  cutCharacterName, isValidCharacterName, checkCharacterCoverage,
  // 导出给单测：这个函数的"空值会吞下一行"曾经污染过真稿的结构化数据（见其注释），
  // 值得直接钉住，而不是只从 parseScript 的间接结果去推断。
  extractField,
};
