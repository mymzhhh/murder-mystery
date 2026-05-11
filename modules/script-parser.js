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
    errors: [],
  };

  try {
    // === 标题 ===
    let titleMatch = markdown.match(/^#\s*《(.+?)》/m);
    if (!titleMatch) titleMatch = markdown.match(/剧本名称[：:]\s*《?(.+?)》?/);
    if (!titleMatch) titleMatch = markdown.match(/\*\*剧本名称\*\*[：:]\s*《?(.+?)》?/);
    result.title = titleMatch ? titleMatch[1].trim() : "未命名剧本";

    // === 基本设定 ===
    result.setting = {
      era: extractField(markdown, "时代背景"),
      location: extractField(markdown, "地点场景"),
      playerCount: extractField(markdown, "参与人数"),
      duration: extractField(markdown, "游戏时长"),
      difficulty: extractField(markdown, "难度等级"),
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

  } catch (e) {
    result.errors.push("解析异常: " + e.message);
  }

  return result;
}

// ==================== 工具函数 ====================

function extractField(text, label) {
  const patterns = [
    new RegExp(`${label}[：:]\\s*(.+?)(?:\\n|$)`, "i"),
    new RegExp(`\\*\\*${label}\\*\\*[：:]\\s*(.+?)(?:\\n|$)`, "i"),
    new RegExp(`${label}\\s*[：:]\\s*(.+?)(?:\\n\\n|\\n#{1,3}|$)`, "is"),
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1].trim().replace(/^[-*]\s*/, "");
  }
  return "";
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
  for (const char of characters) {
    const escapedName = escapeRegex(char.name);

    // 尝试多种标题格式匹配角色剧本区域
    const patterns = [
      `(?:玩家角色|NPC|角色)\\s*\\d+[：:]\\s*${escapedName}(?:\\s*\\[.*?\\])?[\\s\\S]*?(?=(?:玩家角色|NPC|角色)\\s*\\d+[：:]|#{1,3}\\s*(?:第[三四五六]|线索|DM|NPC嫌疑人|场景布局)|$)`,
      // 松散匹配：角色名后直到下个角色或章节结束
      `#{2,4}\\s*${escapedName}(?:\\s*\\[.*?\\])?[\\s\\S]*?(?=#{2,4}\\s*(?:${characters.map(c => escapeRegex(c.name)).join('|')})|#{1,3}\\s*(?:第[三四五六]|线索|DM|NPC嫌疑人)|$)`,
    ];

    let section = null;
    for (const pat of patterns) {
      const regex = new RegExp(pat, "i");
      const match = markdown.match(regex);
      if (match) { section = match[0]; break; }
    }
    if (!section) continue;

    // 根据角色类型提取不同字段
    const isNpc = char.roleType === "npc";
    const isPlayer = char.roleType === "player" || !isNpc;

    if (isNpc) {
      // NPC：提取背景故事、动机、秘密、时间线、物品等
      char.script = {
        story: extractSection(section, "背景故事", 4000) || section.substring(0, 4000),
        secret: extractField(section, "秘密") || extractSection(section, "秘密", 2000),
        motive: extractSection(section, "作案动机", 2000),
        personalTimeline: extractSection(section, "时间线", 5000),
        items: extractSection(section, "相关物品", 2000),
        method: extractSection(section, "作案过程", 5000),
        fullScript: section.substring(0, 12000),
      };
    } else {
      char.script = {
        story: extractField(section, "你的故事") || extractSection(section, "你的故事", 4000) || extractSection(section, "背景故事", 4000),
        secret: extractField(section, "你的秘密") || extractSection(section, "你的秘密", 2000) || extractField(section, "秘密"),
        personalTimeline: extractSection(section, "你的时间线", 3000) || extractSection(section, "时间线", 3000),
        goals: extractSection(section, "你的目标", 2000) || extractSection(section, "调查目标", 2000),
        knownInfo: extractSection(section, "你掌握的信息", 3000) || extractSection(section, "初步信息", 3000),
        items: extractSection(section, "你的物品", 2000) || extractSection(section, "物品", 2000),
        fullScript: section.substring(0, 10000),
      };
    }
  }
}

function extractAllClues(markdown) {
  const rounds = { round1: [], round2: [], round3: [], redHerrings: [] };

  // Find the clues section
  let clueSection = extractSection(markdown, "线索系统", 50000);
  if (!clueSection || clueSection.length < 200) {
    clueSection = extractSection(markdown, "第三部分", 50000);
  }
  if (!clueSection || clueSection.length < 200) {
    const idx = markdown.search(/(?:线索系统|第三部分|#{1,3}\s*《.+?》完整线索)/i);
    clueSection = idx >= 0 ? markdown.substring(idx, idx + 30000) : "";
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
  const allClues = [...rounds.round1, ...rounds.round2, ...rounds.round3];
  if (allClues.length === 0) {
    rounds.round1 = parseClueSection(clueSection, "A", 1);
    rounds.round2 = [];
    rounds.round3 = [];
  }

  return rounds;
}

function parseClueSection(text, prefix, roundNum) {
  const clues = [];
  // Split by "### Xn：" headings (A/B/C/M prefix)
  const clueBlocks = text.split(/\n(?=###\s+[A-CM]\d+[：:\s])/);

  for (const block of clueBlocks) {
    // Extract clue ID: match "### A1" or "### A1："
    const idMatch = block.match(/^###\s+([A-CM]\d+)/m);
    if (!idMatch) continue;

    const id = idMatch[1];
    const roundForClue = id.startsWith("M") ? roundNum : roundNum; // 误导线索归入当前轮
    const clue = { id, round: roundForClue, content: "", pointsTo: "", clueType: "", location: "" };

    // Extract fields from bullet points with bold labels
    const contentMatch = block.match(/\*\*线索内容\*\*[：:]\s*([\s\S]+?)(?=\n- \*\*|\n---|\n$)/);
    if (contentMatch) clue.content = contentMatch[1].trim().replace(/\n/g, " ");

    const locMatch = block.match(/\*\*发现地点\*\*[：:]\s*(.+)/);
    if (locMatch) clue.location = locMatch[1].trim();

    const typeMatch = block.match(/\*\*线索类型\*\*[：:]\s*(.+)/);
    if (typeMatch) clue.clueType = typeMatch[1].trim();

    // If content is still empty, take the entire body
    if (!clue.content) {
      const bodyMatch = block.match(/^###\s+[A-CM]\d+[：:\s]*[^\n]*\n([\s\S]+)/);
      if (bodyMatch) {
        clue.content = bodyMatch[1].trim().substring(0, 500);
      }
    }

    if (clue.content || clue.pointsTo) clues.push(clue);
  }

  // Fallback: match "- **线索内容**" directly
  if (clues.length === 0) {
    const lines = text.split("\n");
    let current = null;
    for (const line of lines) {
      const bidMatch = line.match(/^[-*]\s*\*\*线索内容\*\*[：:]\s*(.+)/);
      if (bidMatch) {
        if (current) clues.push(current);
        current = { id: `${prefix}${clues.length + 1}`, round: roundNum, content: bidMatch[1].trim(), pointsTo: "", clueType: "" };
        continue;
      }
      if (current) {
        const pm = line.match(/^[-*]\s*\*\*指向角色\/?事件\*\*[：:]\s*(.+)/);
        if (pm) { current.pointsTo = pm[1].trim(); continue; }
        const tm = line.match(/^[-*]\s*\*\*线索类型\*\*[：:]\s*(.+)/);
        if (tm) { current.clueType = tm[1].trim(); continue; }
      }
    }
    if (current) clues.push(current);
  }

  return clues;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { parseScript };
