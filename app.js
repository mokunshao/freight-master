// 浏览器端核心：全部逻辑跑在前端，配置存 localStorage，可静态托管（GitHub Pages 直接跑）
// 对外暴露 window.freightApi，接口与旧桌面端 IPC 完全一致，renderer.js 无需改动
(function () {
  'use strict';

  const STORAGE_KEY = 'freight-master-config-v1';
  const CONFIG_FORMAT = 'freight-master-config';
  const CONFIG_VERSION = 1;
  const DEFAULT_VOL_DIVISOR = 6000;

  // ---------- 常量 ----------

  // 条件字段分两级：主字段（类别）+ 次级字段（真正参与比较的值）
  const FIELD_GROUPS = [
    {
      key: 'side',
      name: '边长',
      unit: 'CM',
      fields: [
        { key: 'longest', label: '最长边' },
        { key: 'second_longest', label: '次长边' },
        { key: 'shortest', label: '最短边' },
      ],
    },
    {
      key: 'weight',
      name: '重量',
      unit: 'KG',
      fields: [
        { key: 'charged_weight', label: '计费重（材积重）' },
        { key: 'weight', label: '实重' },
      ],
    },
    { key: 'girth', name: '围长', unit: 'CM', fields: null },
    { key: 'volume', name: '体积', unit: 'CM³', fields: null },
  ];

  const FIELD_LABELS = FIELD_GROUPS.reduce((acc, g) => {
    if (!g.fields) {
      acc[g.key] = `${g.name} (${g.unit})`;
      return acc;
    }
    g.fields.forEach(f => {
      acc[f.key] = `${f.label} (${g.unit})`;
    });
    return acc;
  }, {});

  // 主字段 key → 该主字段下的次级字段列表（没有次级字段的用主字段自己兜底，上层逻辑保持一致）
  function conditionKeysOf(mainField) {
    const g = FIELD_GROUPS.find(x => x.key === mainField) || FIELD_GROUPS[0];
    return g.fields ? g.fields.map(f => f.key) : [g.key];
  }

  const COMBINE_MODE_LABELS = {
    add: '叠加',
    not_stack: '不叠加',
    max: '不叠加取最大值',
    cardispatch: '卡派',
    notice: '提醒',
    reject: '拒收',
  };

  // 目的地分组：mode=zip 按邮编匹配，mode=country 直接选择地区/国家
  // 现在目的地可以自行增删改名，这份表只用于「出厂默认数据」和给缺字段的目的地补默认值
  const GROUP_META = [
    { key: 'us', name: '美国', mode: 'zip', surchargeMode: 'stack', minWeightSingle: 10, minWeightPerBox: 10 },
    { key: 'eu', name: '欧洲', mode: 'country', surchargeMode: 'max', minWeightSingle: 10, minWeightPerBox: 10 },
    { key: 'ca', name: '加拿大', mode: 'country', surchargeMode: 'stack', minWeightSingle: 10, minWeightPerBox: 10 },
    { key: 'uk', name: '英国', mode: 'country', surchargeMode: 'stack', minWeightSingle: 10, minWeightPerBox: 10 },
    { key: 'au', name: '澳大利亚', mode: 'country', surchargeMode: 'stack', minWeightSingle: 10, minWeightPerBox: 10 },
  ];

  // 出厂默认数据（首次打开写入，也用于「恢复默认数据」）
  const DEFAULT_DATA = {
    us: {
      tiers: [10, 21, 71, 101],
      rows: [
        { name: '美西（邮编8,9开头）', matchKey: '8,9', prices: [16.7, 15.2, 13.2, 12.2] },
        { name: '美中（邮编4,5,6,7开头）', matchKey: '4,5,6,7', prices: [17.7, 16.2, 14.2, 13.2] },
        { name: '美东（邮编0,1,2,3开头）', matchKey: '0,1,2,3', prices: [18.7, 17.2, 15.2, 14.2] },
      ],
      rules: [
        { rule_group: '实重', field: 'weight', conditions: { weight: { min: 22.5 } }, amount: 120, combine_mode: 'add', enabled: 1 },
        { rule_group: '围长', field: 'girth', conditions: { girth: { min: 265 } }, amount: 120, combine_mode: 'add', enabled: 1 },
        // 单边：最长边 / 次长边写在同一条规则里（满足其一，只收一次）
        { rule_group: '单边', field: 'side', conditions: { longest: { min: 120 }, second_longest: { min: 75 } }, amount: 120, combine_mode: 'add', enabled: 1 },
        { rule_group: '超大件', field: 'girth', conditions: { girth: { min: 330 } }, amount: 500, combine_mode: 'max', enabled: 1 },
        { rule_group: '超大件', field: 'volume', conditions: { volume: { min: 283168 } }, amount: 500, combine_mode: 'max', enabled: 1 },
        { rule_group: '超大件', field: 'weight', conditions: { weight: { min: 50 } }, amount: 500, combine_mode: 'max', enabled: 1 },
      ],
      combos: [
        { name: '实重', mode: 'add', indexes: [0], exclusive: [] },
        { name: '围长', mode: 'add', indexes: [1], exclusive: [] },
        { name: '单边', mode: 'add', indexes: [2], exclusive: [] },
        { name: '超大件', mode: 'add', indexes: [3, 4, 5], exclusive: [] },
      ],
      maxRules: [3, 4, 5],
    },
    eu: {
      tiers: [10, 21, 101],
      rows: [
        { name: 'Germany 德国', prices: [15.5, 15.0, 15.0] },
        { name: 'Poland, Belgium, Luxembourg 波兰、比利时、卢森堡', prices: [18.0, 18.0, 17.0] },
        { name: 'Czech Republic, Slovakia, Austria, Hungary 捷克、斯洛伐克、奥地利、匈牙利', prices: [18.0, 18.0, 17.5] },
        { name: 'France 法国', prices: [18.5, 18.0, 17.0] },
        { name: 'Netherlands, Denmark, Estonia, Lithuania, Monaco, Latvia, Spain(except islands), Italy(except islands) 荷兰、丹麦、爱沙尼亚、立陶宛、摩纳哥、拉脱维亚、西班牙(岛屿除外)、意大利(岛屿除外)', prices: [19.0, 19.0, 18.0] },
        { name: 'Slovenia, Croatia, Finland, Sweden, Bulgaria 斯洛文利亚、克罗地亚、芬兰、瑞典、保加利亚', prices: [19.5, 19.0, 19.0] },
        { name: 'Greece, Ireland, Portugal 希腊、爱尔兰、葡萄牙', prices: [21.0, 21.0, 20.0] },
      ],
      rules: [
        { rule_group: '围长330', field: 'girth', conditions: { girth: { min: 330 } }, amount: 350, combine_mode: 'max', enabled: 1 },
        { rule_group: '围长300', field: 'girth', conditions: { girth: { min: 300 } }, amount: 300, combine_mode: 'max', enabled: 1 },
        { rule_group: '实重30', field: 'weight', conditions: { weight: { min: 30 } }, amount: 300, combine_mode: 'max', enabled: 1 },
      ],
      combos: [
        { name: '围长330', mode: 'add', indexes: [0], exclusive: [] },
        { name: '围长300', mode: 'add', indexes: [1], exclusive: [] },
        { name: '实重30', mode: 'add', indexes: [2], exclusive: [] },
      ],
      maxRules: [0, 1, 2],
    },
    ca: {
      tiers: [10, 21, 101],
      rows: [{ name: '加拿大 Canada', prices: [0, 0, 0] }],
      rules: [
        { rule_group: '①实重', field: 'weight', conditions: { weight: { min: 22 } }, amount: 130, combine_mode: 'add' },
        { rule_group: '②单边', field: 'side', conditions: { longest: { min: 121 }, second_longest: { min: 75 } }, amount: 130, combine_mode: 'add' },
        { rule_group: '③围长', field: 'girth', conditions: { girth: { min: 265 } }, amount: 130, combine_mode: 'add' },
        { rule_group: '④超大件', field: 'girth', conditions: { girth: { min: 320 } }, amount: 700, combine_mode: 'max' },
        { rule_group: '④超大件', field: 'weight', conditions: { weight: { min: 40 } }, amount: 700, combine_mode: 'max' },
        { rule_group: '⑤不收货', field: 'weight', conditions: { weight: { min: 68 } }, amount: 0, combine_mode: 'reject' },
        { rule_group: '⑤不收货', field: 'side', conditions: { longest: { min: 151 } }, amount: 0, combine_mode: 'reject' },
        { rule_group: '⑤不收货', field: 'girth', conditions: { girth: { min: 400 } }, amount: 0, combine_mode: 'reject' },
      ],
      combos: [
        { name: '①实重', mode: 'add', indexes: [0], exclusive: [] },
        { name: '②单边', mode: 'add', indexes: [1], exclusive: [] },
        { name: '③围长', mode: 'add', indexes: [2], exclusive: [] },
        { name: '④超大件', mode: 'add', indexes: [3, 4], exclusive: [] },
        { name: '⑤不收货', mode: 'reject', indexes: [5, 6, 7], exclusive: [] },
      ],
      maxRules: [3, 4],
    },
    uk: {
      tiers: [10, 21, 101],
      rows: [{ name: '英国 United Kingdom', prices: [0, 0, 0] }],
      rules: [
        { rule_group: '①实重30-40', field: 'weight', conditions: { weight: { min: 30, max: 40 } }, amount: 330, combine_mode: 'add' },
        // ②尺寸：三边条件写在同一条规则里（满足其一，只收一次）
        { rule_group: '②尺寸', field: 'side', conditions: { longest: { min: 100, max: 150 }, second_longest: { min: 70, max: 100 }, shortest: { min: 60, max: 100 } }, amount: 300, combine_mode: 'add' },
        { rule_group: '③围长', field: 'girth', conditions: { girth: { min: 300, max: 400 } }, amount: 300, combine_mode: 'add' },
      ],
      // ①与②、①与③都能叠加；②与③互不叠加（各填对方的序号即可，关系是双向的）
      combos: [
        { name: '①实重30-40', mode: 'add', indexes: [0], exclusive: [] },
        { name: '②尺寸', mode: 'add', indexes: [1], exclusive: [2] },
        { name: '③围长', mode: 'add', indexes: [2], exclusive: [1] },
      ],
      maxRules: [],
    },
    au: {
      tiers: [10, 21, 101],
      rows: [{ name: '澳大利亚 Australia', prices: [0, 0, 0] }],
      rules: [
        { rule_group: '计费重≥30', field: 'weight', conditions: { charged_weight: { min: 30, max: 35 } }, amount: 100, combine_mode: 'add' },
        { rule_group: '计费重≥35', field: 'weight', conditions: { charged_weight: { min: 35, max: 80 } }, amount: 300, combine_mode: 'add' },
        { rule_group: '计费重≥80', field: 'weight', conditions: { charged_weight: { min: 80 } }, amount: 300, combine_mode: 'add' },
        { rule_group: '单边120-199', field: 'side', conditions: { longest: { min: 120, max: 200 } }, amount: 100, combine_mode: 'add' },
        { rule_group: '单边200-299', field: 'side', conditions: { longest: { min: 200, max: 300 } }, amount: 200, combine_mode: 'add' },
        { rule_group: '木托盘提醒', field: 'weight', conditions: { weight: { min: 30 } }, amount: 0, combine_mode: 'notice' },
      ],
      combos: [
        { name: '计费重≥30', mode: 'add', indexes: [0], exclusive: [] },
        { name: '计费重≥35', mode: 'add', indexes: [1], exclusive: [] },
        { name: '计费重≥80', mode: 'add', indexes: [2], exclusive: [] },
        { name: '单边120-199', mode: 'add', indexes: [3], exclusive: [] },
        { name: '单边200-299', mode: 'add', indexes: [4], exclusive: [] },
        { name: '木托盘提醒', mode: 'notice', indexes: [5], exclusive: [] },
      ],
      maxRules: [],
    },
  };

  // ---------- 工具 ----------

  function toNum(value, fallback) {
    const n = Number(value);
    return value === '' || value === null || value === undefined || isNaN(n) ? fallback : n;
  }

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  const clone = obj => JSON.parse(JSON.stringify(obj));

  // ---------- 状态（localStorage 持久化） ----------

  let state = null;
  let nextId = 1; // 行 / 阶梯 / 规则共用的自增 id

  function allocId() {
    return nextId++;
  }

  // 目的地（国家）的默认值：出厂 meta 里没有的（用户新增的）就用这套兜底
  function metaOf(key) {
    return GROUP_META.find(m => m.key === key) || {};
  }

  function defaultGroupName(key) {
    return metaOf(key).name || key;
  }

  // 新增目的地时生成不重复的 key：英文名直接小写，中文名退化成 g1 / g2 …
  function allocGroupKey(name) {
    const ascii = String(name || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    let key = ascii || `g${state.groups.length + 1}`;
    let n = 2;
    while (state.groups.some(g => g.key === key)) key = `${ascii || 'g'}${n++}`;
    return key;
  }

  // 目的地名称校验：不可为空、不可与别的目的地重名
  function validateGroupName(name, selfKey) {
    const clean = String(name === undefined || name === null ? '' : name).trim();
    if (!clean) throw new Error('目的地名称不能为空');
    if (state.groups.some(g => g.name === clean && g.key !== selfKey)) {
      throw new Error(`已存在同名目的地：${clean}`);
    }
    return clean;
  }

  function seedState() {
    const fresh = { volDivisor: DEFAULT_VOL_DIVISOR, groups: [] };
    GROUP_META.forEach(meta => {
      const data = DEFAULT_DATA[meta.key];
      const tiers = data.tiers.map(w => ({ id: allocId(), min_weight: Number(w), label: `${Number(w)}KG+` }));
      const rows = data.rows.map(r => {
        const row = { id: allocId(), row_name: r.name, match_key: r.matchKey || null, prices: {} };
        r.prices.forEach((p, i) => {
          if (tiers[i]) row.prices[tiers[i].id] = p;
        });
        return row;
      });
      const rules = data.rules.map(rule => ({ id: allocId(), group_key: meta.key, ...normalizeRule(rule) }));
      const combos = sanitizeCombos(data.combos, rules);
      const maxRules = sanitizeMax(data.maxRules, rules);
      fresh.groups.push({
        key: meta.key,
        name: meta.name,
        mode: meta.mode,
        surchargeMode: meta.surchargeMode,
        minWeightSingle: meta.minWeightSingle,
        minWeightPerBox: meta.minWeightPerBox,
        combos,
        maxRules,
        tiers,
        rows,
        rules,
      });
    });
    return fresh;
  }

  // 落库前把每条规则修成合法形状：主字段 + 次级字段条件 + 金额 + 行为
  // conditions = { 次级字段: { min, max } }，min 是下限（≥），max 是可留空的上限（<）
  // 次级字段全部非必填：没填的不进 conditions，一条都没填的规则不参与命中
  function normalizeRule(rule) {
    const raw = rule || {};
    const main = FIELD_GROUPS.find(g => g.key === raw.field) ? raw.field : FIELD_GROUPS[0].key;
    const allowed = conditionKeysOf(main);
    const conditions = {};

    if (raw.conditions && typeof raw.conditions === 'object') {
      allowed.forEach(key => {
        const cond = raw.conditions[key];
        if (!cond || typeof cond !== 'object') return;
        conditions[key] = { min: toNum(cond.min, null), max: toNum(cond.max, null) };
      });
    }

    // 两个框都留空 = 该次级字段不参与判断
    Object.keys(conditions).forEach(key => {
      if (conditions[key].min === null && conditions[key].max === null) delete conditions[key];
    });

    return {
      // 规则组留空 = 未编入任何组合（不生效），不要兜底成别的名字
      rule_group: String(raw.rule_group === undefined || raw.rule_group === null ? '' : raw.rule_group).trim(),
      field: main,
      conditions,
      amount: toNum(raw.amount, 0),
      combine_mode: COMBINE_MODE_LABELS[raw.combine_mode] ? raw.combine_mode : 'add',
      enabled: raw.enabled === undefined ? 1 : Number(raw.enabled) === 1 ? 1 : 0,
    };
  }

  // 组合自己持有「名字 + 行为 + 成员下标 + 不与…叠加」
  function sanitizeCombos(list, rules) {
    const count = (rules || []).length;
    const total = Array.isArray(list) ? list.length : 0;
    const cleaned = [];
    (Array.isArray(list) ? list : []).forEach((c, ci) => {
      const name = String((c && c.name) || '').trim();
      if (!name) return; // 只丢空名；同名组合是允许的（组合之间独立，按位置区分）
      const indexes = (Array.isArray(c.indexes) ? c.indexes : [])
        .map(i => toNum(i, -1))
        .filter(i => i >= 0 && i < count)
        .sort((a, b) => a - b);
      cleaned.push({
        name,
        mode: COMBINE_MODE_LABELS[c.mode] ? c.mode : 'add',
        indexes: Array.from(new Set(indexes)),
        exclusive: (Array.isArray(c && c.exclusive) ? c.exclusive : [])
          .map(i => toNum(i, -1))
          .filter(i => i >= 0 && i < total && i !== ci),
      });
    });
    // 「不与…叠加」是对称关系：A 勾了 B，就等价于 B 也勾了 A
    cleaned.forEach((c, ci) => {
      c.exclusive.forEach(other => {
        if (cleaned[other] && !cleaned[other].exclusive.includes(ci)) cleaned[other].exclusive.push(ci);
      });
    });
    cleaned.forEach(c => {
      c.exclusive = Array.from(new Set(c.exclusive)).sort((a, b) => a - b);
    });
    return cleaned;
  }

  // 「不叠加取最高」单独存一份规则下标：它优先级最高，不挂在组合下面
  function sanitizeMax(list, rules) {
    const count = (rules || []).length;
    return Array.from(
      new Set((Array.isArray(list) ? list : []).map(i => toNum(i, -1)).filter(i => i >= 0 && i < count))
    ).sort((a, b) => a - b);
  }

  // 校验 localStorage 里的数据是否还认得出来；不认得就重新播种
  // 目的地数量不限（可自由增删），只要求每个目的地自己结构完整
  function validStoredState(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    if (!Array.isArray(raw.groups) || !raw.groups.length) return false;
    return raw.groups.every(g => {
      if (!g || typeof g !== 'object' || !String(g.key || '').trim()) return false;
      if (!Array.isArray(g.tiers) || !g.tiers.length) return false;
      if (!Array.isArray(g.rows) || !Array.isArray(g.rules)) return false;
      return g.rows.every(r => r && typeof r === 'object' && r.prices && typeof r.prices === 'object');
    });
  }

  // 宽容地整理已存数据：数字字段 toNum 兜底、规则逐条 normalize
  // 目的地按存下来的顺序原样保留（用户新增的不会被丢掉）；缺的字段用出厂 meta 或通用默认值补
  function normalizeStoredState(raw) {
    const seenKeys = new Set();
    const groups = raw.groups.map(g => {
      const rawKey = String(g.key || '').trim();
      // 极端情况下（手工改 localStorage）出现重复 key 就补后缀，避免两个目的地互相覆盖
      let key = rawKey;
      let n = 2;
      while (seenKeys.has(key)) key = `${rawKey}-${n++}`;
      seenKeys.add(key);

      const meta = metaOf(rawKey);
      const tiers = (g.tiers || []).map(t => {
        const minWeight = toNum(t.min_weight, 0);
        return {
          id: toNum(t.id, 0) || allocId(),
          min_weight: minWeight,
          label: t.label || `${minWeight}KG+`,
        };
      });
      const rows = (g.rows || []).map(r => {
        const prices = {};
        Object.keys(r.prices || {}).forEach(k => {
          const tierId = toNum(k, null);
          if (tierId !== null && tiers.some(t => t.id === tierId)) prices[tierId] = toNum(r.prices[k], 0);
        });
        return {
          id: toNum(r.id, 0) || allocId(),
          row_name: r.row_name || '未命名地区',
          match_key: r.match_key || null,
          prices,
        };
      });
      const rules = (g.rules || []).map(r => {
        const normalized = normalizeRule(r);
        return { id: toNum(r.id, 0) || allocId(), group_key: key, ...normalized };
      });
      const combos = sanitizeCombos(g.combos, rules);
      const maxRules = sanitizeMax(g.maxRules, rules);

      const mode = g.mode === 'zip' || g.mode === 'country' ? g.mode : meta.mode || 'country';
      return {
        key,
        name: String(g.name || meta.name || key).trim() || key,
        mode,
        surchargeMode: meta.surchargeMode || 'stack',
        minWeightSingle: Math.max(0, toNum(g.minWeightSingle, meta.minWeightSingle === undefined ? 10 : meta.minWeightSingle)),
        minWeightPerBox: Math.max(0, toNum(g.minWeightPerBox, meta.minWeightPerBox === undefined ? 10 : meta.minWeightPerBox)),
        combos,
        maxRules,
        tiers,
        rows,
        rules,
      };
    });
    return { volDivisor: toNum(raw.volDivisor, DEFAULT_VOL_DIVISOR) || DEFAULT_VOL_DIVISOR, groups };
  }

  function loadState() {
    let raw = null;
    try {
      raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    } catch (err) {
      raw = null;
    }
    state = validStoredState(raw) ? normalizeStoredState(raw) : seedState();
    bumpNextId(state);
    persist();
  }

  // 让自增 id 避开已有 id（导入的数据带着原 id 进来时尤其重要）
  function bumpNextId(st) {
    let max = 0;
    st.groups.forEach(g => {
      [g.tiers, g.rows, g.rules].forEach(list => {
        (list || []).forEach(item => {
          max = Math.max(max, toNum(item.id, 0) || 0);
        });
      });
    });
    nextId = Math.max(nextId, max + 1);
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (err) {
      // 隐身模式 / 存储被禁用时静默失败：本次会话内仍可用，刷新后回到默认数据
      console.warn('配置保存失败（localStorage 不可用）：', err);
    }
  }

  function findGroup(groupKey) {
    return state.groups.find(g => g.key === groupKey);
  }

  function getGroupConfig(groupKey) {
    const group = findGroup(groupKey);
    if (!group) throw new Error('未知的目的地');
    return clone(group);
  }

  function getConfig() {
    return clone(state);
  }

  // ---------- 计算 ----------

  function measure(length, width, height, volDivisor) {
    const sides = [Number(length), Number(width), Number(height)].sort((a, b) => a - b);
    const volume = length * width * height;
    return {
      sides,
      volume,
      girth: (sides[0] + sides[1]) * 2 + sides[2],
      longest: sides[2],
      secondLongest: sides[1],
      shortest: sides[0],
      volWeight: Math.ceil(volume / volDivisor),
    };
  }

  // 报价表第一栏 = 起重；计费重 = max(起重, 体积重)
  function pickTier(tiers, chargedWeight) {
    const sorted = [...tiers].sort((a, b) => a.min_weight - b.min_weight);
    let chosen = sorted[0];
    sorted.forEach(tier => {
      if (chargedWeight >= tier.min_weight) chosen = tier;
    });
    return chosen;
  }

  // 单个次级字段的区间判断：下限（≥）+ 可选上限（<），两边都能留空
  function conditionMatches(cond, value) {
    const { min, max } = cond || {};
    if (min !== null && min !== undefined && min !== '' && !(value >= Number(min))) return false;
    if (max !== null && max !== undefined && max !== '' && !(value < Number(max))) return false;
    return true;
  }

  // 规则命中：**填过的次级字段里任意一个满足**，整条规则就命中（所有次级字段算一个整体，只收一次金额）
  // 返回命中的那个次级字段；一条次级字段都没填 = 永不命中
  function hitKey(rule, fields) {
    const keys = Object.keys(rule.conditions || {});
    if (!keys.length) return null;
    return (
      keys.find(key => {
        const value = fields[key];
        if (value === undefined || value === null || value === '' || Number.isNaN(Number(value))) return false;
        return conditionMatches(rule.conditions[key], Number(value));
      }) || null
    );
  }

  function ruleMatches(rule, fields) {
    return hitKey(rule, fields) !== null;
  }

  function formatRange(cond) {
    const hasMin = cond.min !== null && cond.min !== undefined && cond.min !== '';
    const hasMax = cond.max !== null && cond.max !== undefined && cond.max !== '';
    if (hasMin && hasMax) return `≥${cond.min} 且 <${cond.max}`;
    if (hasMax) return `<${cond.max}`;
    if (hasMin) return `≥${cond.min}`;
    return '不限';
  }

  // 整条规则的描述：所有次级字段条件用「或」串起来（一个整体）
  function formatConditions(rule) {
    const keys = Object.keys(rule.conditions || {});
    if (!keys.length) return '未设置条件（不会命中）';
    return keys.map(key => `${FIELD_LABELS[key] || key} ${formatRange(rule.conditions[key])}`).join(' 或 ');
  }

  function ruleMode(rule) {
    if (rule.combine_mode && COMBINE_MODE_LABELS[rule.combine_mode]) return rule.combine_mode;
    return 'add';
  }

  // 在「不与…叠加」这张冲突图里，挑出**互不冲突且金额总和最大**的一组组合
  // 例：①330 能与 ②300、③300 叠加，但 ② 与 ③ 勾了互不叠加 → 命中①②③ 收 630，命中②③ 收 300
  // 组合数很少（一般不超过 10 个），直接枚举所有子集取最优
  function pickBestCombos(candidates, conflict) {
    const n = candidates.length;
    if (!n) return new Set();

    if (n <= 20) {
      let bestMask = 0;
      let bestSum = -1;
      let bestCount = -1;
      for (let mask = 0; mask < (1 << n); mask++) {
        let ok = true;
        for (let i = 0; i < n && ok; i++) {
          if (!(mask & (1 << i))) continue;
          for (let j = i + 1; j < n; j++) {
            if (mask & (1 << j) && conflict(candidates[i].idx, candidates[j].idx)) {
              ok = false;
              break;
            }
          }
        }
        if (!ok) continue;
        let total = 0;
        let count = 0;
        for (let i = 0; i < n; i++) {
          if (mask & (1 << i)) {
            total = round2(total + candidates[i].amount);
            count++;
          }
        }
        // 金额相同时优先收组合更多的一组（明细更完整）
        if (total > bestSum || (total === bestSum && count > bestCount)) {
          bestSum = total;
          bestCount = count;
          bestMask = mask;
        }
      }
      return new Set(candidates.filter((c, i) => bestMask & (1 << i)));
    }

    // 组合特别多（>20）时枚举量太大，退化成贪心：金额从高到低，不冲突就收
    const ordered = candidates.slice().sort((a, b) => b.amount - a.amount);
    const picked = new Set();
    ordered.forEach(c => {
      if (Array.from(picked).some(x => conflict(c.idx, x.idx))) return;
      picked.add(c);
    });
    return picked;
  }

  // 附加费计算：完全由每条规则的「行为」（combine_mode）驱动
  function calculateSurcharge(m, rules) {
    const fields = {
      weight: m.actualWeight,
      charged_weight: m.chargedWeight,
      girth: m.girth,
      longest: m.longest,
      second_longest: m.secondLongest,
      shortest: m.shortest,
      volume: m.volume,
    };

    // 调用方已按组合筛好：只有被编入组合的规则才会传进来
    const enabled = rules;
    const note = rule => `${rule.comboName || rule.rule_group || '规则'}：${formatConditions(rule)}`;

    // 拒收：命中任意一条即不收货
    const rejected = enabled.find(r => ruleMode(r) === 'reject' && ruleMatches(r, fields));
    if (rejected) {
      const key = hitKey(rejected, fields);
      return {
        rejected: true,
        rejectReason: `${note(rejected)}，当前 ${FIELD_LABELS[key] || key} = ${fields[key]}`,
        surcharge: 0,
        detail: [],
      };
    }

    const detail = [];

    // 提醒：不收费
    enabled
      .filter(r => ruleMode(r) === 'notice' && ruleMatches(r, fields))
      .forEach(r => {
        const key = hitKey(r, fields);
        detail.push(`提醒：${note(r)}，当前 ${FIELD_LABELS[key] || key} = ${fields[key]}`);
      });

    const sum = list => round2(list.reduce((acc, c) => acc + c.amount, 0));
    const lines = list => list.reduce((acc, c) => acc.concat(c.lines), []);

    // 先按组合归堆，算出每个组合自己的金额：
    // add = 组内命中的金额相加；not_stack / cardispatch = 组内取最高的一条
    const byCombo = mode => {
      const map = new Map();
      enabled
        .filter(r => ruleMode(r) === mode && ruleMatches(r, fields))
        .forEach(r => {
          const amount = toNum(r.amount, 0);
          const line = `${note(r)} → +${amount} 元`;
          const found = map.get(String(r.comboKey));
          if (!found) {
            map.set(String(r.comboKey), { idx: Number(r.comboKey), name: r.comboName || '', amount, lines: [line] });
            return;
          }
          if (mode === 'add') {
            found.amount = round2(found.amount + amount);
            found.lines.push(line);
          } else if (amount > found.amount) {
            found.amount = amount;
            found.lines = [line];
          }
        });
      return Array.from(map.values());
    };

    // 卡派：组内取最高、组间累加，永远不受任何「不叠加」影响
    const dispatch = byCombo('cardispatch');

    // 不叠加取最高：命中即只收最高的一条，所有叠加 / 不叠加组合都不计
    const exclusive = enabled.filter(r => ruleMode(r) === 'max' && ruleMatches(r, fields));
    if (exclusive.length) {
      const best = exclusive.reduce((a, b) => (toNum(b.amount, 0) > toNum(a.amount, 0) ? b : a));
      // 取最高区是独立区域，note 里已经带「不叠加取最高」前缀，这里不再重复
      detail.push(`${note(best)} → +${toNum(best.amount, 0)} 元`);
      return {
        rejected: false,
        surcharge: round2(toNum(best.amount, 0) + sum(dispatch)),
        detail: [...detail, ...lines(dispatch)],
      };
    }

    // 组合之间的「不与…叠加」：A 勾了 B = A、B 不能同时收（关系对称）
    const conflicts = new Map(); // 组合下标 → 不与之叠加的组合下标集合
    enabled.forEach(r => {
      const idx = Number(r.comboKey);
      (r.comboExclusive || []).forEach(other => {
        if (other === idx || Number.isNaN(other)) return;
        if (!conflicts.has(idx)) conflicts.set(idx, new Set());
        if (!conflicts.has(other)) conflicts.set(other, new Set());
        conflicts.get(idx).add(other);
        conflicts.get(other).add(idx);
      });
    });
    const conflict = (a, b) => {
      const sa = conflicts.get(a);
      const sb = conflicts.get(b);
      return (sa && sa.has(b)) || (sb && sb.has(a)) || false;
    };

    // 剩下的组合：在「互不冲突」的前提下挑金额总和最大的一组（组合数很少，直接枚举）
    const candidates = byCombo('add')
      .concat(byCombo('not_stack'))
      .filter(c => c.amount > 0);
    const picked = pickBestCombos(candidates, conflict);
    const chosen = candidates.filter(c => picked.has(c));
    const dropped = candidates.filter(c => !picked.has(c));

    chosen.forEach(c => detail.push(...c.lines));
    dropped.forEach(c => {
      const partners = chosen.filter(x => conflict(c.idx, x.idx)).map(x => `「${x.name}」`).join('、');
      detail.push(
        partners
          ? `未计入：${c.name} +${c.amount} 元（与 ${partners} 不叠加）`
          : `未计入：${c.name} +${c.amount} 元（组合冲突，取金额最大的一组）`
      );
    });

    return {
      rejected: false,
      surcharge: round2(sum(chosen) + sum(dispatch)),
      detail: [...detail, ...lines(dispatch)],
    };
  }

  function normalizeBoxes(boxes) {
    const list = Array.isArray(boxes) ? boxes : [];
    const result = list
      .map(box => ({
        length: Number(box.length),
        width: Number(box.width),
        height: Number(box.height),
        weight: Number(box.weight),
      }))
      .filter(box => box.length > 0 && box.width > 0 && box.height > 0 && !isNaN(box.weight));
    if (!result.length) throw new Error('请至少填写一个完整的箱规（长、宽、高、实重）');
    return result;
  }

  // 最低计费重（起算）：只有一箱时用「单箱起算」，多箱时每个箱各按「多箱起算」
  function getMinWeight(group, boxCount) {
    const fallback = boxCount > 1 ? group.minWeightPerBox : group.minWeightSingle;
    const value = toNum(fallback, 10);
    return value > 0 ? value : 0;
  }

  function calculateGroup(groupKey, selection, rawBoxes) {
    const group = findGroup(groupKey);
    if (!group) throw new Error('未知的目的地');

    let row = null;
    if (group.mode === 'zip') {
      const first = String(selection.zip || '').trim()[0];
      if (!/[0-9]/.test(first || '')) throw new Error(`请输入「${group.name}」的邮编（按首字符匹配区域）`);
      row = group.rows.find(r => `,${r.match_key || ''},`.includes(`,${first},`));
      if (!row) {
        throw new Error(
          `「${group.name}」里没有邮编 ${first} 开头的区域，请到「价格管理」补充对应区域行，或换一个邮编`
        );
      }
    } else {
      row = group.rows.find(r => r.id === Number(selection.rowId));
      if (!row) throw new Error('请选择目的地');
    }

    if (!group.tiers.length) throw new Error(`「${group.name}」还没有设置报价阶梯`);
    const volDivisor = toNum(state.volDivisor, DEFAULT_VOL_DIVISOR) || DEFAULT_VOL_DIVISOR;

    // 「不叠加取最高」优先级最高：进了这里的规则只按取最高算，不再走所属组合
    const maxIdx = new Set(sanitizeMax(group.maxRules, group.rules));

    // 参与计算的规则 = 被组合勾选的规则；行为（叠加 / 卡派 …）以组合为准，与规则的规则组名无关
    // 组合之间独立：同一条规则被多个组合勾选时，会在每个组合里各算一次
    const activeRules = [];
    (group.combos || []).forEach((combo, comboIdx) => {
      (combo.indexes || []).forEach(idx => {
        const rule = group.rules[idx];
        if (!rule || maxIdx.has(idx)) return;
        // comboExclusive = 本组合「不与…叠加」的其他组合下标，交给计算端处理组合之间的关系
        activeRules.push({
          ...rule,
          combine_mode: combo.mode,
          comboName: combo.name,
          comboKey: comboIdx,
          comboExclusive: Array.isArray(combo.exclusive) ? combo.exclusive.slice() : [],
        });
      });
    });
    maxIdx.forEach(idx => {
      const rule = group.rules[idx];
      if (!rule) return;
      activeRules.push({ ...rule, combine_mode: 'max', comboName: '不叠加取最高', comboKey: 'max' });
    });

    const boxes = normalizeBoxes(rawBoxes);
    const minWeight = getMinWeight(group, boxes.length); // 起算重量：一箱 / 多箱每箱

    // 1) 先算每箱的计费重（起算重量为下限，不满起算重按起算重）
    const measured = boxes.map(box => {
      const m = measure(box.length, box.width, box.height, volDivisor);
      m.actualWeight = box.weight;
      m.sidesText = `${box.length}×${box.width}×${box.height}`;
      m.chargedWeight = Math.max(minWeight, m.volWeight);
      return m;
    });

    // 2) 阶梯按「整票合计计费重」取一档，所有箱共用这个单价
    //    合计重不满最低阶梯（如 10KG+）时按最低档算
    const totalChargedWeight = round2(measured.reduce((acc, m) => acc + m.chargedWeight, 0));
    const tier = pickTier(group.tiers, totalChargedWeight);
    const unitPrice = toNum(row.prices[tier.id], 0);

    const items = measured.map((m, index) => {
      const chargedWeight = m.chargedWeight;
      const baseFreight = chargedWeight * unitPrice;

      const { rejected, rejectReason, surcharge, detail } = calculateSurcharge(m, activeRules);
      if (rejected) {
        throw new Error(
          `第 ${index + 1} 箱超出「${group.name}」承运范围，不收货 —— ${rejectReason}。请调整该箱或联系货代确认。`
        );
      }

      return {
        index: index + 1,
        sides: m.sidesText,
        girth: m.girth,
        volume: m.volume,
        actualWeight: m.actualWeight,
        volWeight: m.volWeight,
        chargedWeight,
        tierLabel: tier.label,
        unitPrice,
        baseFreight: round2(baseFreight),
        surcharge: round2(surcharge),
        surchargeDetail: detail,
        total: round2(baseFreight + surcharge),
      };
    });

    const sum = key => round2(items.reduce((acc, item) => acc + item[key], 0));
    return {
      groupName: group.name,
      destination: row.row_name,
      minWeight,
      minWeightSingle: getMinWeight(group, 1),
      minWeightPerBox: getMinWeight(group, 2),
      minWeightMode: boxes.length > 1 ? 'per_box' : 'single',
      boxes: items,
      summary: {
        boxCount: items.length,
        totalActualWeight: sum('actualWeight'),
        totalChargedWeight: sum('chargedWeight'),
        totalVolume: sum('volume'),
        totalBaseFreight: sum('baseFreight'),
        totalSurcharge: sum('surcharge'),
        total: sum('total'),
      },
    };
  }

  // ---------- 配置修改 ----------

  function saveGroupConfig(data) {
    const group = findGroup(data.groupKey);
    if (!group) throw new Error('未知的目的地');

    // 目的地改名（与单价表、规则一起随本页保存）
    if (data.name !== undefined && String(data.name).trim() !== group.name) {
      group.name = validateGroupName(data.name, group.key);
    }

    // 起算重量：一箱起算 / 多箱每箱起算
    if (data.minWeightSingle !== undefined && data.minWeightSingle !== '') {
      group.minWeightSingle = Math.max(0, toNum(data.minWeightSingle, 0));
    }
    if (data.minWeightPerBox !== undefined && data.minWeightPerBox !== '') {
      group.minWeightPerBox = Math.max(0, toNum(data.minWeightPerBox, 0));
    }

    (data.tiers || []).forEach(t => {
      const tier = group.tiers.find(x => x.id === Number(t.id));
      if (!tier) return;
      tier.min_weight = toNum(t.min_weight, 0);
      tier.label = `${tier.min_weight}KG+`;
    });

    (data.rows || []).forEach(r => {
      const row = group.rows.find(x => x.id === Number(r.id));
      if (!row) return;
      row.row_name = r.name;
      row.match_key = r.matchKey || null;
      Object.keys(r.prices || {}).forEach(tierId => {
        row.prices[tierId] = toNum(r.prices[tierId], 0);
      });
    });

    // 规则整组替换（与桌面端行为一致）
    group.rules = (data.rules || []).map(rule => ({ id: allocId(), group_key: group.key, ...normalizeRule(rule) }));

    // 组合列表独立提交（空数组 = 确实没有组合，不要回退推导）
    if (Array.isArray(data.combos)) group.combos = sanitizeCombos(data.combos, group.rules);
    // 「不叠加取最高」独立提交
    if (Array.isArray(data.maxRules)) group.maxRules = sanitizeMax(data.maxRules, group.rules);

    persist();
    return getGroupConfig(group.key);
  }

  function addRateRow(groupKey, name, matchKey) {
    const group = findGroup(groupKey);
    if (!group) throw new Error('未知的目的地');
    const row = { id: allocId(), row_name: name || '新增地区', match_key: matchKey || null, prices: {} };
    group.tiers.forEach(tier => {
      row.prices[tier.id] = 0;
    });
    group.rows.push(row);
    persist();
    return getGroupConfig(groupKey);
  }

  function deleteRateRow(groupKey, rowId) {
    const group = findGroup(groupKey);
    if (!group) throw new Error('未知的目的地');
    group.rows = group.rows.filter(r => r.id !== Number(rowId));
    persist();
    return getGroupConfig(groupKey);
  }

  // ---------- 阶梯（价格列）数量 ----------

  const MAX_TIERS = 12;

  // 各列默认的起始重量：3 列 = 10/21/101（除美国外的默认值），4 列 = 10/21/71/101（美国的默认值）
  // 更多列在 101 之后每档 +100，起始重量都能在表头直接改
  function defaultTierWeights(count) {
    const presets = { 1: [10], 2: [10, 21], 3: [10, 21, 101], 4: [10, 21, 71, 101] };
    if (presets[count]) return presets[count].slice();
    const list = [10, 21, 71, 101];
    let last = list[list.length - 1];
    while (list.length < count) {
      last += 100;
      list.push(last);
    }
    return list;
  }

  // 设置单价表的列数：阶梯 id 按位置复用，行里的单价跟着位置走；多出来的列补 0
  function setTierCount(groupKey, count) {
    const group = findGroup(groupKey);
    if (!group) throw new Error('未知的目的地');
    const total = toNum(count, 0);
    if (!Number.isInteger(total) || total < 1 || total > MAX_TIERS) {
      throw new Error(`阶梯列数需要在 1 ~ ${MAX_TIERS} 之间`);
    }
    const ladder = defaultTierWeights(total);
    const tiers = ladder.map((w, i) => ({
      id: group.tiers[i] ? group.tiers[i].id : allocId(),
      min_weight: w,
      label: `${w}KG+`,
    }));
    group.rows.forEach(row => {
      const old = row.prices || {};
      const prices = {};
      tiers.forEach(t => {
        prices[t.id] = toNum(old[t.id], 0);
      });
      row.prices = prices;
    });
    group.tiers = tiers;
    persist();
    return getGroupConfig(groupKey);
  }

  // ---------- 目的地（国家）增删 ----------

  // 新目的地：默认阶梯 10 / 21 / 101KG+，**不带地区行**（点「+ 新增地区」建第一行时会先问列数），没有规则
  function addGroup(name, mode) {
    const cleanName = validateGroupName(name, null);
    const cleanMode = mode === 'zip' ? 'zip' : 'country';
    const key = allocGroupKey(cleanName);
    const tiers = [10, 21, 101].map(w => ({ id: allocId(), min_weight: w, label: `${w}KG+` }));

    const group = {
      key,
      name: cleanName,
      mode: cleanMode,
      surchargeMode: 'stack',
      minWeightSingle: 10,
      minWeightPerBox: 10,
      combos: [],
      maxRules: [],
      tiers,
      rows: [],
      rules: [],
    };
    state.groups.push(group);
    persist();
    return getGroupConfig(key);
  }

  function deleteGroup(groupKey) {
    if (state.groups.length <= 1) throw new Error('至少要保留一个目的地');
    const index = state.groups.findIndex(g => g.key === groupKey);
    if (index < 0) throw new Error('未知的目的地');
    state.groups.splice(index, 1);
    persist();
    return true;
  }

  function setVolDivisor(value) {
    state.volDivisor = toNum(value, DEFAULT_VOL_DIVISOR) || DEFAULT_VOL_DIVISOR;
    persist();
    return true;
  }

  function resetDatabase() {
    state = seedState();
    persist();
    return true;
  }

  // ---------- 配置导出 / 导入（只认 format + version 对得上的配置） ----------

  function buildExportPayload() {
    return {
      format: CONFIG_FORMAT,
      version: CONFIG_VERSION,
      exportedAt: new Date().toISOString(),
      volDivisor: toNum(state.volDivisor, DEFAULT_VOL_DIVISOR),
      groups: state.groups.map(group => ({
        key: group.key,
        name: group.name,
        mode: group.mode,
        minWeightSingle: toNum(group.minWeightSingle, 10),
        minWeightPerBox: toNum(group.minWeightPerBox, 10),
        combos: (group.combos || []).map(c => ({
          name: c.name,
          mode: COMBINE_MODE_LABELS[c.mode] ? c.mode : 'add',
          indexes: (c.indexes || []).slice(),
          exclusive: (c.exclusive || []).slice(),
        })),
        maxRules: (group.maxRules || []).slice(),
        tiers: group.tiers.map(t => ({
          id: t.id,
          min_weight: toNum(t.min_weight, 0),
          label: t.label || `${toNum(t.min_weight, 0)}KG+`,
        })),
        rows: group.rows.map(row => ({
          id: row.id,
          name: row.row_name,
          matchKey: row.match_key || null,
          prices: Object.keys(row.prices || {}).reduce((acc, tierId) => {
            acc[tierId] = toNum(row.prices[tierId], 0);
            return acc;
          }, {}),
        })),
        rules: group.rules.map(r => {
          const normalized = normalizeRule(r);
          return {
            rule_group: normalized.rule_group,
            field: normalized.field,
            conditions: normalized.conditions,
            amount: normalized.amount,
            combine_mode: normalized.combine_mode,
            enabled: normalized.enabled,
          };
        }),
      })),
    };
  }

  // 先整份校验，通过后再覆盖，避免写一半失败留下脏数据
  function applyImportPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('配置文件格式不正确');
    }
    if (payload.format !== CONFIG_FORMAT) {
      throw new Error('不是本项目导出的配置文件（缺少 format 标记）');
    }
    if (toNum(payload.version, 0) !== CONFIG_VERSION) {
      throw new Error(`配置版本不匹配：需要 ${CONFIG_VERSION}，文件里是 ${payload.version}`);
    }
    if (!Array.isArray(payload.groups) || !payload.groups.length) {
      throw new Error('配置文件里没有找到目的地数据（groups 为空）');
    }

    const seen = new Set();
    const plans = payload.groups.map(item => {
      if (!item || typeof item !== 'object' || !String(item.key || '').trim()) {
        throw new Error('存在缺少 key 的目的地配置');
      }
      // 目的地可以自行新增，配置里出现出厂没有的 key 也照收
      const key = String(item.key).trim();
      const meta = metaOf(key);
      if (seen.has(key)) throw new Error(`配置里目的地重复：${key}`);
      seen.add(key);

      const name = String(item.name || meta.name || key).trim();
      const mode = item.mode === 'zip' || item.mode === 'country' ? item.mode : meta.mode || 'country';

      const tiers = (Array.isArray(item.tiers) ? item.tiers : []).map(t => ({
        min_weight: toNum(t.min_weight, 0),
        label: t.label || `${toNum(t.min_weight, 0)}KG+`,
      }));
      if (!tiers.length) throw new Error(`「${name}」缺少报价阶梯`);

      const rows = (Array.isArray(item.rows) ? item.rows : []).map(r => {
        const prices = {};
        Object.keys(r.prices || {}).forEach(k => {
          prices[toNum(k, 0)] = toNum(r.prices[k], 0);
        });
        return {
          name: r.name || '未命名地区',
          matchKey: r.matchKey || null,
          prices,
        };
      });

      const rules = (Array.isArray(item.rules) ? item.rules : []).map(r => normalizeRule(r));
      if (!Array.isArray(item.combos)) throw new Error(`「${name}」缺少组合配置（combos）`);
      const combos = sanitizeCombos(item.combos, rules);
      if (!Array.isArray(item.maxRules)) throw new Error(`「${name}」缺少「不叠加取最高」配置（maxRules）`);
      const maxRules = sanitizeMax(item.maxRules, rules);

      return {
        key,
        name,
        mode,
        minWeightSingle: Math.max(0, toNum(item.minWeightSingle, meta.minWeightSingle === undefined ? 10 : meta.minWeightSingle)),
        minWeightPerBox: Math.max(0, toNum(item.minWeightPerBox, meta.minWeightPerBox === undefined ? 10 : meta.minWeightPerBox)),
        combos,
        maxRules,
        tiers,
        rows,
        rules,
      };
    });

    // 沿用文件里的 id（单价与阶梯的对应关系不会错位）；
    // 只有同一目的地内部出现重复阶梯 id 时才换新 id 并重映射
    const groups = plans.map(plan => {
      const seenTierIds = new Set();
      const tiers = plan.tiers.map(t => {
        const oldId = toNum(t.id, null);
        const id = oldId !== null && !seenTierIds.has(oldId) ? oldId : allocId();
        if (oldId !== null) seenTierIds.add(oldId);
        return { id, min_weight: t.min_weight, label: t.label };
      });
      const tierIdMap = {}; // 文件里的旧阶梯 id → 本地阶梯 id
      plan.tiers.forEach((t, i) => {
        const oldId = toNum(t.id, i + 1);
        tierIdMap[oldId] = tiers[i].id;
        tierIdMap[String(oldId)] = tiers[i].id;
      });

      const rows = plan.rows.map(r => {
        const row = { id: allocId(), row_name: r.name, match_key: r.matchKey || null, prices: {} };
        Object.keys(r.prices).forEach(oldTierId => {
          const newTierId =
            tierIdMap[oldTierId] !== undefined ? tierIdMap[oldTierId] : tierIdMap[Number(oldTierId)];
          if (newTierId !== undefined) row.prices[newTierId] = toNum(r.prices[oldTierId], 0);
        });
        return row;
      });

      const rules = plan.rules.map(rule => ({ id: allocId(), group_key: plan.key, ...rule }));

      return {
        key: plan.key,
        name: plan.name,
        mode: plan.mode,
        surchargeMode: metaOf(plan.key).surchargeMode || 'stack',
        minWeightSingle: plan.minWeightSingle,
        minWeightPerBox: plan.minWeightPerBox,
        combos: plan.combos,
        maxRules: plan.maxRules,
        tiers,
        rows,
        rules,
      };
    });

    state = { volDivisor: toNum(payload.volDivisor, DEFAULT_VOL_DIVISOR) || DEFAULT_VOL_DIVISOR, groups };
    bumpNextId(state);
    persist();
    return getConfig();
  }

  // ---------- 导出下载 / 导入选文件 ----------

  function downloadJson(payload) {
    const fileName = `freight-master-config-${new Date().toISOString().slice(0, 10)}.json`;
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 立刻 revoke 会在部分环境（Electron 打包后）打断还没开始的下载，延后释放
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return fileName;
  }

  function pickJsonFile() {
    return new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.style.display = 'none';
      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        input.remove();
        if (!file) return resolve(null);
        const reader = new FileReader();
        reader.onload = () => resolve({ name: file.name, text: String(reader.result) });
        reader.onerror = () => resolve(null);
        reader.readAsText(file);
      });
      document.body.appendChild(input);
      input.click();
    });
  }

  // ---------- 启动 ----------

  loadState();

  window.freightApi = {
    getConfig: () => Promise.resolve(getConfig()),
    getGroupConfig: key => Promise.resolve(getGroupConfig(key)),
    calculate: data =>
      Promise.resolve(calculateGroup(data.groupKey, { zip: data.zip, rowId: data.rowId }, data.boxes)),
    saveGroup: data => Promise.resolve(saveGroupConfig(data)),
    addGroup: data => Promise.resolve(addGroup(data && data.name, data && data.mode)),
    deleteGroup: data => Promise.resolve(deleteGroup(data && data.groupKey)),
    addRateRow: data => Promise.resolve(addRateRow(data.groupKey, data.name, data.matchKey)),
    deleteRateRow: data => Promise.resolve(deleteRateRow(data.groupKey, data.rowId)),
    setTierCount: data => Promise.resolve(setTierCount(data.groupKey, data.count)),
    setVolDivisor: value => Promise.resolve(setVolDivisor(value)),
    resetDatabase: () => Promise.resolve(resetDatabase()),
    exportConfig: async () => {
      const payload = buildExportPayload();
      return { ok: true, filePath: downloadJson(payload) };
    },
    importConfig: async () => {
      const picked = await pickJsonFile();
      if (!picked) return { ok: false, canceled: true };
      let payload;
      try {
        payload = JSON.parse(picked.text);
      } catch (err) {
        throw new Error('不是有效的 JSON 文件');
      }
      const config = applyImportPayload(payload);
      return { ok: true, filePath: picked.name, config };
    },
  };
})();
