// 剧本解析器 — 将 Markdown 剧本转为结构化 JSON

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
      truthReveal: extractSection(markdown, "真相复盘", 3000),
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
  const patterns = [
    new RegExp(`${label}[：:]\\s*?(.+?)(?:\\r?\\n|$)`, "i"),
    new RegExp(`\\*\\*${label}\\*\\*[：:]\\s*?(.+?)(?:\\r?\\n|$)`, "i"),
    new RegExp(`${label}\\s*[：:]\\s*?(.+?)(?:\\r?\\n\\r?\\n|\\r?\\n#{1,3}|$)`, "is"),
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
  // 支持多种标题格式
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `(?:#{1,4}\\s*)?${escaped}[：:]?[\\s\\S]*?(?=\\n#{1,4}\\s+(?:${escaped}|第[一二三四五六]|角色\\s*\\d|一[、.]|二[、.]|三[、.]|四[、.]|五[、.]|六[、.])|\\n---|$)`,
    "i"
  );
  const m = text.match(pattern);
  if (!m) return "";
  let content = m[0].replace(new RegExp(`^#{1,4}\\s*${escaped}[：:]?\\s*`, "i"), "").trim();
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
      const name = match[1].trim();
      if (!name || name.length < 2 || name.length > 6) continue;
      if (/凶手|死者|角色|未知|年龄|性别|嫌疑人/.test(name)) continue;
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
      const occMatch = block.match(/职业[\/身份]*[：:]\s*(.+?)(?:\n|$)/);
      const occupation = occMatch ? occMatch[1].trim() : "";

      chars.push({
        name, age: "", gender: "", occupation, personality: "",
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
      const nameMatch = line.match(/[-*]\s*\*\*姓名\*\*[：:]\s*(.{2,6})/);
      if (nameMatch) {
        const name = nameMatch[1].trim().replace(/\*+/g, "");
        if (name.length >= 2 && name.length <= 6 && !/凶手|死者|角色|未知/.test(name)) {
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
        const nameMatch = h.match(/角色[：:、\s]*(.{2,6})$/);
        if (nameMatch) {
          const n = nameMatch[1].trim();
          if (n.length >= 2 && n.length <= 6) chars.push({ name: n, age: "", gender: "", occupation: "", personality: "", relationshipToVictim: "", isMurderer: false });
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
        secret: extractSection(section, "需要隐瞒", 2000) || extractSection(section, "秘密", 2000),
        motive: extractSection(section, "作案动机", 2000),
        personalTimeline: extractSection(section, "时间线", 5000),
        items: extractSection(section, "可供审讯透露", 2000) || extractSection(section, "相关物品", 2000),
        method: extractSection(section, "凶手确认", 5000) || extractSection(section, "作案过程", 5000),
        fullScript: section.substring(0, 12000),
      };
    } else {
      char.script = {
        story: extractSection(section, "你的背景故事", 5000) || extractField(section, "你的身份") || extractSection(section, "你的身份", 4000) || extractField(section, "案发背景") || extractSection(section, "案发背景", 4000) || extractField(section, "你的故事") || extractSection(section, "你的故事", 4000) || extractSection(section, "背景故事", 4000),
        secret: extractSection(section, "你需要隐瞒的事", 2000) || extractField(section, "你要隐瞒的") || extractSection(section, "你要隐瞒的", 2000) || extractField(section, "你的秘密") || extractSection(section, "你的秘密", 2000) || extractField(section, "秘密"),
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
    const clue = { id, round: roundForClue, content: "", pointsTo: "", clueType: "", location: "" };

    // 逐行解析字段（兼容 **加粗** 与 普通 两种标签格式）
    // 字段行："- 线索类型：xxx" / "- **发现地点**：xxx" 等
    const fieldLine = /^\s*[-*]\s*(?:\*\*)?(线索类型|发现地点|线索内容|指向角色\/?事件)(?:\*\*)?[：:]\s*(.+)\s*$/;
    let pendingContent = null; // 遇到"线索内容"行后，把后续非字段行拼进来（支持多行内容）
    for (const line of block.split("\n")) {
      const fm = line.match(fieldLine);
      if (fm) {
        if (fm[1] === "线索类型") clue.clueType = fm[2].trim();
        else if (fm[1] === "发现地点") clue.location = fm[2].trim();
        else if (fm[1] === "线索内容") { clue.content = fm[2].trim(); pendingContent = true; }
        else if (fm[1] === "指向角色" || fm[1] === "指向角色/事件") clue.pointsTo = fm[2].trim();
      } else if (pendingContent) {
        const t = line.trim();
        // 续行终止条件：空行 / "---"分隔线 / "#标题" / "|"表格行（防止把后续章节如"推理链总结"吞进线索内容）
        if (!t || t === "---" || /^#{1,6}\s/.test(t) || /^\|/.test(t) || /^[-*]\s*(?:线索类型|发现地点|线索内容|指向角色\/?事件)/.test(t)) {
          pendingContent = false;
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
  return { script: String(text || ""), secret: String(secret || "") };
}

module.exports = { parseScript, normalizeCharacterScript };
