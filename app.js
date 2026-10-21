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

  const COMBINE_MODE_LABELS = {
    add: '叠加',
    not_stack: '不叠加',
    max: '不叠加取最大值',
    cardispatch: '卡派',
    notice: '提醒',
    reject: '拒收',
  };

  // 目的地分组：mode=zip 按邮编匹配，mode=country 直接选择地区/国家
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
        { rule_group: '实重', field: 'weight', threshold: 22.5, amount: 120, combine_mode: 'add', enabled: 1 },
        { rule_group: '围长', field: 'girth', threshold: 265, amount: 120, combine_mode: 'add', enabled: 1 },
        { rule_group: '单边', field: 'longest', threshold: 120, amount: 120, combine_mode: 'add', enabled: 1 },
        { rule_group: '单边', field: 'second_longest', threshold: 75, amount: 120, combine_mode: 'add', enabled: 1 },
        { rule_group: '超大件', field: 'girth', threshold: 330, amount: 500, combine_mode: 'max', enabled: 1 },
        { rule_group: '超大件', field: 'volume', threshold: 283168, amount: 500, combine_mode: 'max', enabled: 1 },
        { rule_group: '超大件', field: 'weight', threshold: 50, amount: 500, combine_mode: 'max', enabled: 1 },
      ],
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
        { rule_group: '围长330', field: 'girth', threshold: 330, amount: 350, combine_mode: 'max', enabled: 1 },
        { rule_group: '围长300', field: 'girth', threshold: 300, amount: 300, combine_mode: 'max', enabled: 1 },
        { rule_group: '实重30', field: 'weight', threshold: 30, amount: 300, combine_mode: 'max', enabled: 1 },
      ],
    },
    ca: {
      tiers: [10, 21, 101],
      rows: [{ name: '加拿大 Canada', prices: [0, 0, 0] }],
      rules: [
        { rule_group: '①实重', field: 'weight', threshold: 22, amount: 130, combine_mode: 'add' },
        { rule_group: '②单边', field: 'longest', threshold: 121, amount: 130, combine_mode: 'add' },
        { rule_group: '②单边', field: 'second_longest', threshold: 75, amount: 130, combine_mode: 'add' },
        { rule_group: '③围长', field: 'girth', threshold: 265, amount: 130, combine_mode: 'add' },
        { rule_group: '④超大件', field: 'girth', threshold: 320, amount: 700, combine_mode: 'max' },
        { rule_group: '④超大件', field: 'weight', threshold: 40, amount: 700, combine_mode: 'max' },
        { rule_group: '⑤不收货', field: 'weight', threshold: 68, amount: 0, combine_mode: 'reject' },
        { rule_group: '⑤不收货', field: 'longest', threshold: 151, amount: 0, combine_mode: 'reject' },
        { rule_group: '⑤不收货', field: 'girth', threshold: 400, amount: 0, combine_mode: 'reject' },
      ],
    },
    uk: {
      tiers: [10, 21, 101],
      rows: [{ name: '英国 United Kingdom', prices: [0, 0, 0] }],
      rules: [
        { rule_group: '①实重30-40', field: 'weight', threshold: 30, threshold_max: 40, amount: 330, combine_mode: 'add' },
        { rule_group: '②③尺寸', field: 'longest', threshold: 100, threshold_max: 150, amount: 300, combine_mode: 'add' },
        { rule_group: '②③尺寸', field: 'second_longest', threshold: 70, threshold_max: 100, amount: 300, combine_mode: 'add' },
        { rule_group: '②③尺寸', field: 'shortest', threshold: 60, threshold_max: 100, amount: 300, combine_mode: 'add' },
        { rule_group: '②③尺寸', field: 'girth', threshold: 300, threshold_max: 400, amount: 300, combine_mode: 'add' },
      ],
    },
    au: {
      tiers: [10, 21, 101],
      rows: [{ name: '澳大利亚 Australia', prices: [0, 0, 0] }],
      rules: [
        { rule_group: '计费重≥30', field: 'charged_weight', threshold: 30, threshold_max: 35, amount: 100, combine_mode: 'add' },
        { rule_group: '计费重≥35', field: 'charged_weight', threshold: 35, threshold_max: 80, amount: 300, combine_mode: 'add' },
        { rule_group: '计费重≥80', field: 'charged_weight', threshold: 80, amount: 300, combine_mode: 'add' },
        { rule_group: '单边120-199', field: 'longest', threshold: 120, threshold_max: 200, amount: 100, combine_mode: 'add' },
        { rule_group: '单边200-299', field: 'longest', threshold: 200, threshold_max: 300, amount: 200, combine_mode: 'add' },
        { rule_group: '木托盘提醒', field: 'weight', threshold: 30, amount: 0, combine_mode: 'notice' },
      ],
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
      const split = splitMaxRules(rules, deriveCombosFromRules(rules));
      fresh.groups.push({
        key: meta.key,
        name: meta.name,
        mode: meta.mode,
        surchargeMode: meta.surchargeMode,
        minWeightSingle: meta.minWeightSingle,
        minWeightPerBox: meta.minWeightPerBox,
        combos: split.combos,
        maxRules: split.maxRules,
        tiers,
        rows,
        rules,
      });
    });
    return fresh;
  }

  // 落库前把每条规则修成合法形状（字段 / 行为 / 启用位兜底）
  function normalizeRule(rule) {
    const thresholdMax =
      rule.threshold_max === '' || rule.threshold_max === null || rule.threshold_max === undefined
        ? null
        : toNum(rule.threshold_max, null);
    return {
      // 规则组留空 = 未编入任何组合（不生效），不要兜底成别的名字
      rule_group: String(rule.rule_group === undefined || rule.rule_group === null ? '' : rule.rule_group).trim(),
      field: FIELD_LABELS[rule.field] ? rule.field : 'weight',
      threshold: toNum(rule.threshold, 0),
      threshold_max: thresholdMax,
      amount: toNum(rule.amount, 0),
      combine_mode: COMBINE_MODE_LABELS[rule.combine_mode] ? rule.combine_mode : 'add',
      enabled: rule.enabled === undefined ? 1 : Number(rule.enabled) === 1 ? 1 : 0,
    };
  }

  // 组合列表（[{name, mode}]）是权威来源；老数据没有这个字段时，从规则里推导一次
  function deriveCombosFromRules(rules) {
    const map = new Map(); // name → { name, mode, indexes }
    (rules || []).forEach((r, i) => {
      const name = String(r.rule_group || '').trim();
      if (!name) return;
      if (!map.has(name)) {
        map.set(name, { name, mode: COMBINE_MODE_LABELS[r.combine_mode] ? r.combine_mode : 'add', indexes: [] });
      }
      map.get(name).indexes.push(i);
    });
    return Array.from(map.values());
  }

  // 组合自己持有成员下标；老格式（只有 name + mode）按规则组名折算一次
  function sanitizeCombos(list, rules) {
    const count = (rules || []).length;
    const cleaned = [];
    (Array.isArray(list) ? list : []).forEach(c => {
      const name = String((c && c.name) || '').trim();
      if (!name) return; // 只丢空名；同名组合是允许的（组合之间独立，按位置区分）
      let indexes = Array.isArray(c.indexes)
        ? c.indexes.map(i => toNum(i, -1)).filter(i => i >= 0 && i < count)
        : null;
      if (indexes === null) {
        indexes = (rules || []).reduce((acc, r, i) => {
          if (String(r.rule_group || '').trim() === name) acc.push(i);
          return acc;
        }, []);
      }
      cleaned.push({
        name,
        mode: COMBINE_MODE_LABELS[c.mode] ? c.mode : 'add',
        indexes: Array.from(new Set(indexes)).sort((a, b) => a - b),
      });
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

  // 老配置里 max 写在规则 / 组合上：搬到独立的 maxRules，组合本身降级为叠加
  function splitMaxRules(rules, combos) {
    const max = new Set();
    (rules || []).forEach((r, i) => {
      if (r.combine_mode === 'max') max.add(i);
    });
    const cleaned = (combos || []).map(c => {
      if (c.mode !== 'max') return c;
      (c.indexes || []).forEach(i => max.add(i));
      return { ...c, mode: 'add' };
    });
    return { combos: cleaned, maxRules: Array.from(max).sort((a, b) => a - b) };
  }

  // 校验 localStorage 里的数据是否还认得出来；不认得就重新播种
  function validStoredState(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    if (!Array.isArray(raw.groups) || raw.groups.length !== GROUP_META.length) return false;
    return GROUP_META.every(meta => {
      const g = raw.groups.find(x => x && x.key === meta.key);
      if (!g || !Array.isArray(g.tiers) || !g.tiers.length) return false;
      if (!Array.isArray(g.rows) || !Array.isArray(g.rules)) return false;
      return g.rows.every(r => r && typeof r === 'object' && r.prices && typeof r.prices === 'object');
    });
  }

  // 宽容地整理已存数据：数字字段 toNum 兜底、规则逐条 normalize
  function normalizeStoredState(raw) {
    const groups = GROUP_META.map(meta => {
      const g = raw.groups.find(x => x && x.key === meta.key);
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
        return { id: toNum(r.id, 0) || allocId(), group_key: meta.key, ...normalized };
      });
      const combos = Array.isArray(g.combos) ? sanitizeCombos(g.combos, rules) : deriveCombosFromRules(rules);
      // 有独立 maxRules 就直接用；老数据则从规则 / 组合上的 max 迁移过来
      const split = Array.isArray(g.maxRules)
        ? { combos, maxRules: sanitizeMax(g.maxRules, rules) }
        : splitMaxRules(rules, combos);

      return {
        key: meta.key,
        name: meta.name,
        mode: meta.mode,
        surchargeMode: meta.surchargeMode,
        minWeightSingle: Math.max(0, toNum(g.minWeightSingle, meta.minWeightSingle)),
        minWeightPerBox: Math.max(0, toNum(g.minWeightPerBox, meta.minWeightPerBox)),
        combos: split.combos,
        maxRules: split.maxRules,
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

  // 规则匹配：下限（≥）+ 可选上限（<）
  function ruleMatches(rule, fields) {
    const value = fields[rule.field];
    if (value === undefined || value === null) return false;
    if (!(value >= toNum(rule.threshold, 0))) return false;
    const max = rule.threshold_max;
    if (max !== null && max !== undefined && max !== '' && !(value < Number(max))) return false;
    return true;
  }

  function formatRange(rule) {
    const max = rule.threshold_max;
    return max !== null && max !== undefined && max !== '' ? `≥${rule.threshold} 且 <${max}` : `≥${rule.threshold}`;
  }

  function ruleMode(rule) {
    if (rule.combine_mode && COMBINE_MODE_LABELS[rule.combine_mode]) return rule.combine_mode;
    return 'add';
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
    const note = rule => `${rule.comboName || rule.rule_group || '规则'}：${FIELD_LABELS[rule.field] || rule.field} ${formatRange(rule)}`;

    // 拒收：命中任意一条即不收货
    const rejected = enabled.find(r => ruleMode(r) === 'reject' && ruleMatches(r, fields));
    if (rejected) {
      return {
        rejected: true,
        rejectReason: `${note(rejected)}，当前值 ${fields[rejected.field]}`,
        surcharge: 0,
        detail: [],
      };
    }

    const detail = [];

    // 提醒：不收费
    enabled
      .filter(r => ruleMode(r) === 'notice' && ruleMatches(r, fields))
      .forEach(r => {
        detail.push(`提醒：${note(r)}，当前值 ${fields[r.field]}`);
      });

    // 组内满足任一条件只收一次（取组内最高），行为相同的组之间再按规则合并
    // 「组」= 规则组组合（成员由组合自己持有，与规则的规则组名无关）
    const groupsOf = mode => {
      const matched = {};
      enabled
        .filter(r => ruleMode(r) === mode && ruleMatches(r, fields))
        .forEach(r => {
          const amount = toNum(r.amount, 0);
          const key = r.comboKey !== undefined ? `c${r.comboKey}` : r.comboName || r.rule_group || '';
          const current = matched[key];
          if (!current || amount > current.amount) {
            matched[key] = { amount, rule: r };
          }
        });
      return Object.values(matched);
    };

    const sum = list => round2(list.reduce((acc, g) => acc + g.amount, 0));
    const describe = list => list.map(g => `${note(g.rule)} → +${g.amount} 元`);

    // 卡派：独立累加，永远不受「不叠加取最大值」影响
    const dispatch = groupsOf('cardispatch');

    // 不叠加取最大值：命中即替换掉所有 叠加 / 不叠加 组
    const exclusive = groupsOf('max');
    if (exclusive.length) {
      const best = exclusive.reduce((a, b) => (b.amount > a.amount ? b : a));
      // 取最高区是独立区域，note 里已经带「不叠加取最高」前缀，这里不再重复
      detail.push(`${note(best.rule)} → +${best.amount} 元`);
      return {
        rejected: false,
        surcharge: round2(best.amount + sum(dispatch)),
        detail: [...detail, ...describe(dispatch)],
      };
    }

    const add = groupsOf('add');
    const notStack = groupsOf('not_stack');
    return {
      rejected: false,
      surcharge: round2(sum(add) + sum(notStack) + sum(dispatch)),
      detail: [...detail, ...describe(add), ...describe(notStack), ...describe(dispatch)],
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
      if (!/[0-9]/.test(first || '')) throw new Error('无法识别的美国邮编，请检查输入');
      row = group.rows.find(r => `,${r.match_key || ''},`.includes(`,${first},`));
      if (!row) throw new Error('无法识别的美国邮编，请检查输入');
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
        activeRules.push({ ...rule, combine_mode: combo.mode, comboName: combo.name, comboKey: comboIdx });
      });
    });
    maxIdx.forEach(idx => {
      const rule = group.rules[idx];
      if (!rule) return;
      activeRules.push({ ...rule, combine_mode: 'max', comboName: '不叠加取最高', comboKey: 'max' });
    });

    const boxes = normalizeBoxes(rawBoxes);
    const minWeight = getMinWeight(group, boxes.length); // 起算重量：一箱 / 多箱每箱
    const items = boxes.map((box, index) => {
      const m = measure(box.length, box.width, box.height, volDivisor);
      m.actualWeight = box.weight;

      // 每箱单独计算：计费重 = max(起重, 体积重)，再按该箱计费重查阶梯、单价
      const chargedWeight = Math.max(minWeight, m.volWeight);
      const tier = pickTier(group.tiers, chargedWeight);
      const unitPrice = toNum(row.prices[tier.id], 0);
      const baseFreight = chargedWeight * unitPrice;
      m.chargedWeight = chargedWeight;

      const { rejected, rejectReason, surcharge, detail } = calculateSurcharge(m, activeRules);
      if (rejected) {
        throw new Error(
          `第 ${index + 1} 箱超出「${group.name}」承运范围，不收货 —— ${rejectReason}。请调整该箱或联系货代确认。`
        );
      }

      return {
        index: index + 1,
        sides: `${box.length}×${box.width}×${box.height}`,
        girth: m.girth,
        volume: m.volume,
        actualWeight: box.weight,
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

  // ---------- 配置导出 / 导入（JSON 格式与旧桌面版完全互通） ----------

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
            threshold: normalized.threshold,
            threshold_max: normalized.threshold_max,
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
    if (!Array.isArray(payload.groups) || !payload.groups.length) {
      throw new Error('配置文件里没有找到目的地数据（groups 为空）');
    }

    const seen = new Set();
    const plans = payload.groups.map(item => {
      if (!item || typeof item !== 'object' || !item.key) {
        throw new Error('存在缺少 key 的目的地配置');
      }
      const meta = GROUP_META.find(m => m.key === item.key);
      if (!meta) throw new Error(`配置里有未知的目的地：${item.key}`);
      if (seen.has(item.key)) throw new Error(`配置里目的地重复：${item.key}`);
      seen.add(item.key);

      const tiers = (Array.isArray(item.tiers) ? item.tiers : []).map(t => ({
        min_weight: toNum(t.min_weight, 0),
        label: t.label || `${toNum(t.min_weight, 0)}KG+`,
      }));
      if (!tiers.length) throw new Error(`「${meta.name}」缺少报价阶梯`);

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
      // 老配置文件（如桌面版导出的）没有 combos，就从规则里推导
      const combos = Array.isArray(item.combos) ? sanitizeCombos(item.combos, rules) : deriveCombosFromRules(rules);
      const split = Array.isArray(item.maxRules)
        ? { combos, maxRules: sanitizeMax(item.maxRules, rules) }
        : splitMaxRules(rules, combos);

      return {
        key: meta.key,
        name: meta.name,
        mode: meta.mode,
        minWeightSingle: Math.max(0, toNum(item.minWeightSingle, meta.minWeightSingle)),
        minWeightPerBox: Math.max(0, toNum(item.minWeightPerBox, meta.minWeightPerBox)),
        combos: split.combos,
        maxRules: split.maxRules,
        tiers,
        rows,
        rules,
      };
    });

    // 沿用文件里的 id（与桌面版一致，单价与阶梯的对应关系不会错位）；
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
        surchargeMode: (GROUP_META.find(m => m.key === plan.key) || {}).surchargeMode,
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
    URL.revokeObjectURL(url);
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
    calculate: data =>
      Promise.resolve(calculateGroup(data.groupKey, { zip: data.zip, rowId: data.rowId }, data.boxes)),
    saveGroup: data => Promise.resolve(saveGroupConfig(data)),
    addRateRow: data => Promise.resolve(addRateRow(data.groupKey, data.name, data.matchKey)),
    deleteRateRow: data => Promise.resolve(deleteRateRow(data.groupKey, data.rowId)),
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
