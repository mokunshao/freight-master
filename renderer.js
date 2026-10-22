const api = window.freightApi;

const MAX_BOXES = 10;

// 条件字段分两级：主字段（类别）+ 次级字段（真正参与比较的值）
// 没有次级字段的类别（围长 / 体积）直接拿主字段当存储值
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

// 叶子字段 → 完整标签（规则组合区展示用）
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

// 叶子字段属于哪个主字段
function fieldGroupOf(field) {
  return (
    FIELD_GROUPS.find(g => (g.fields ? g.fields.some(f => f.key === field) : g.key === field)) ||
    FIELD_GROUPS[0]
  );
}

// 次级字段下拉：没有次级字段时禁用
function subFieldOptions(rule) {
  const group = fieldGroupOf(rule.field);
  if (!group.fields) {
    return '<select data-field="field_sub" disabled><option value="">—</option></select>';
  }
  return `<select data-field="field_sub">${group.fields
    .map(f => `<option value="${f.key}" ${rule.field === f.key ? 'selected' : ''}>${f.label}</option>`)
    .join('')}</select>`;
}

// 附加费行为：逐条规则配置，取代原来的「类型 + 国家级叠加方式」
// 组合可选的行为。「不叠加取最高」不在这里 —— 它优先级最高，在下方独立区域里配置
const COMBINE_MODE_LABELS = {
  add: '叠加（命中的都要，金额累加）',
  not_stack: '不叠加（组内只收最高的一条）',
  cardispatch: '卡派（组内取最高，独立累加）',
  notice: '提醒（不收费）',
  reject: '拒收（达到即不收货）',
};

const COMBINE_MODE_HINTS = {
  add: '同一个组合内命中几条就收几条、金额相加；不同组合之间再相加。',
  not_stack: '同一个组合内命中多条时只收金额最高的那一条；不同组合之间相加。',
  cardispatch: '卡车派送等固定费用：组内取最高，单独累加，不受「不叠加取最高」影响。',
  notice: '不产生费用，只在结果里给出提示。',
  reject: '命中即视为超出承运范围，计算时直接报错。',
};

let config = { volDivisor: 6000, groups: [] };
let boxes = [createBox()];

// 每个目的地「最近一次保存」的快照，用来判断页面上是否有未保存的改动
const savedSnapshots = new Map();

const groupSelect = document.getElementById('group');
const zipGroup = document.getElementById('zip-group');
const countryGroup = document.getElementById('country-group');
const countrySelect = document.getElementById('country');
const zipInput = document.getElementById('zip');

const boxesBody = document.getElementById('boxes-body');
const boxHint = document.getElementById('box-hint');
const btnAddBox = document.getElementById('btn-add-box');
const btnClearBoxes = document.getElementById('btn-clear-boxes');
const btnClearAll = document.getElementById('btn-clear-all');
const btnCalc = document.getElementById('btn-calc');

const resultCard = document.getElementById('result');
const resultGrid = document.getElementById('result-grid');
const boxDetailBody = document.getElementById('box-detail-body');
const surchargeDetail = document.getElementById('surcharge-detail');

const volDivisorInput = document.getElementById('vol-divisor');
const btnSaveVol = document.getElementById('btn-save-vol');
const groupTabs = document.getElementById('group-tabs');
const groupPanels = document.getElementById('group-panels');
const btnReset = document.getElementById('btn-reset');

const toast = document.getElementById('toast');

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 4000);
}

function formatMoney(n) {
  return '¥' + Number(n).toFixed(2);
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}

function currentGroupKey() {
  return groupSelect.value;
}

function currentGroupMeta() {
  return config.groups.find(g => g.key === currentGroupKey());
}

// ---------- 箱规 ----------
function createBox() {
  return { length: '', width: '', height: '', weight: '' };
}

function renderBoxes() {
  boxesBody.innerHTML = '';
  boxes.forEach((box, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td><input type="number" min="0" step="0.1" data-index="${i}" data-field="length" value="${box.length}" placeholder="长"></td>
      <td><input type="number" min="0" step="0.1" data-index="${i}" data-field="width" value="${box.width}" placeholder="宽"></td>
      <td><input type="number" min="0" step="0.1" data-index="${i}" data-field="height" value="${box.height}" placeholder="高"></td>
      <td><input type="number" min="0" step="0.1" data-index="${i}" data-field="weight" value="${box.weight}" placeholder="实重"></td>
      <td><button class="btn-link" data-remove="${i}" ${boxes.length === 1 ? 'disabled' : ''}>删除</button></td>
    `;
    boxesBody.appendChild(tr);
  });

  btnAddBox.disabled = boxes.length >= MAX_BOXES;
  boxHint.textContent = `已填写 ${boxes.length} / ${MAX_BOXES} 个箱规；每箱单独计算计费重与附加费，最后自动汇总。` +
    (boxes.length >= MAX_BOXES ? '（已达上限）' : '');
}

function getFilledBoxes() {
  return boxes
    .map(box => ({
      length: Number(box.length),
      width: Number(box.width),
      height: Number(box.height),
      weight: Number(box.weight),
    }))
    .filter(box => box.length > 0 && box.width > 0 && box.height > 0 && !isNaN(box.weight));
}

boxesBody.addEventListener('input', e => {
  const index = e.target.dataset.index;
  const field = e.target.dataset.field;
  if (index === undefined || !field) return;
  boxes[Number(index)][field] = e.target.value;
});

boxesBody.addEventListener('click', e => {
  const index = e.target.dataset.remove;
  if (index === undefined) return;
  boxes.splice(Number(index), 1);
  if (!boxes.length) boxes.push(createBox());
  renderBoxes();
});

btnAddBox.addEventListener('click', () => {
  if (boxes.length >= MAX_BOXES) {
    showToast(`最多只能添加 ${MAX_BOXES} 个箱规`);
    return;
  }
  boxes.push(createBox());
  renderBoxes();
});

btnClearBoxes.addEventListener('click', () => {
  boxes = [createBox()];
  renderBoxes();
  resultCard.style.display = 'none';
  showToast('箱规已清空');
});

btnClearAll.addEventListener('click', () => {
  boxes = [createBox()];
  renderBoxes();
  zipInput.value = '';
  if (countrySelect.options.length) countrySelect.selectedIndex = 0;
  resultCard.style.display = 'none';
  showToast('箱规与目的地已清空');
});

// ---------- 批量导入箱规 ----------
const btnBulkToggle = document.getElementById('btn-bulk-toggle');
const bulkPanel = document.getElementById('bulk-panel');
const bulkText = document.getElementById('bulk-text');
const btnBulkFill = document.getElementById('btn-bulk-fill');
const btnBulkCalc = document.getElementById('btn-bulk-calc');
const btnBulkCancel = document.getElementById('btn-bulk-cancel');
const bulkFeedback = document.getElementById('bulk-feedback');

// 从一段文本里挑出「重量 + 三边尺寸」，一行一箱；重量和尺寸分行写也能配上
function parseBulkBoxes(text) {
  const parsed = [];
  const errors = [];
  let pendingWeight = null;

  String(text || '')
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const line = raw.trim();
      if (!line) return;

      // 重量：优先找带单位的（32.60kg / 32.60 千克 / 32.60公斤），退化到「重量」关键字后的数字
      const weightMatch =
        line.match(/(\d+(?:\.\d+)?)\s*(?:kg|千克|公斤)/i) ||
        line.match(/(?:重量|实重|weight)\s*[:：]?\s*(\d+(?:\.\d+)?)/i);
      const weight = weightMatch ? Number(weightMatch[1]) : null;

      // 尺寸：三个数用 x × * · / 等分隔（69*67*59、69x67x59、69×67×59）
      const sizeMatch = line.match(
        /(\d+(?:\.\d+)?)\s*[xX×*·\/\\]\s*(\d+(?:\.\d+)?)\s*[xX×*·\/\\]\s*(\d+(?:\.\d+)?)/
      );
      const dims = sizeMatch ? [Number(sizeMatch[1]), Number(sizeMatch[2]), Number(sizeMatch[3])] : null;

      // 只有重量：先记下，等下一行给尺寸
      if (weight !== null && !dims) {
        pendingWeight = weight;
        return;
      }

      if (dims) {
        const resolvedWeight = weight !== null ? weight : pendingWeight;
        pendingWeight = null;
        if (resolvedWeight === null) {
          errors.push(`第 ${i + 1} 行：识别到尺寸 ${dims.join('×')}，但没找到重量`);
          return;
        }
        parsed.push({ length: dims[0], width: dims[1], height: dims[2], weight: resolvedWeight });
        return;
      }

      errors.push(`第 ${i + 1} 行：「${line}」 无法识别（需要重量和三边尺寸）`);
    });

  return { parsed, errors };
}

function applyParsedBoxes(parsed) {
  boxes = parsed.map(b => ({
    length: String(b.length),
    width: String(b.width),
    height: String(b.height),
    weight: String(b.weight),
  }));
  if (!boxes.length) boxes.push(createBox());
  renderBoxes();
}

btnBulkToggle.addEventListener('click', () => {
  const opening = bulkPanel.style.display === 'none';
  bulkPanel.style.display = opening ? 'block' : 'none';
  bulkFeedback.textContent = '';
  if (opening) bulkText.focus();
});

btnBulkCancel.addEventListener('click', () => {
  bulkPanel.style.display = 'none';
  bulkText.value = '';
  bulkFeedback.textContent = '';
});

btnBulkFill.addEventListener('click', () => {
  const { parsed, errors } = parseBulkBoxes(bulkText.value);
  if (!parsed.length) {
    bulkFeedback.innerHTML = `<span class="warn">没有识别到任何箱规。${errors.join('；')}</span>`;
    return;
  }
  applyParsedBoxes(parsed);
  bulkFeedback.innerHTML =
    `<span class="ok">已填入 ${parsed.length} 箱：` +
    parsed.map(b => `${b.length}×${b.width}×${b.height} / ${b.weight}kg`).join('；') +
    `</span>` + (errors.length ? `<br><span class="warn">${errors.join('；')}</span>` : '');
});

btnBulkCalc.addEventListener('click', async () => {
  const { parsed, errors } = parseBulkBoxes(bulkText.value);
  if (!parsed.length) {
    bulkFeedback.innerHTML = `<span class="warn">没有识别到任何箱规。${errors.join('；')}</span>`;
    return;
  }
  applyParsedBoxes(parsed);
  bulkFeedback.innerHTML =
    `<span class="ok">已填入 ${parsed.length} 箱，开始计算…</span>` +
    (errors.length ? `<br><span class="warn">${errors.join('；')}</span>` : '');
  await runCalculate();
});

// ---------- 目的地 ----------
function renderGroupOptions() {
  const current = groupSelect.value;
  groupSelect.innerHTML = '';
  config.groups.forEach(group => {
    const option = document.createElement('option');
    option.value = group.key;
    option.textContent = group.name;
    groupSelect.appendChild(option);
  });
  if (current && config.groups.some(g => g.key === current)) groupSelect.value = current;
}

function renderCountryOptions() {
  const group = currentGroupMeta();
  const current = countrySelect.value;
  countrySelect.innerHTML = '';
  (group ? group.rows : []).forEach(row => {
    const option = document.createElement('option');
    option.value = row.id;
    option.textContent = row.row_name;
    countrySelect.appendChild(option);
  });
  if (current) countrySelect.value = current;
}

function switchGroup() {
  const group = currentGroupMeta();
  if (!group) return;
  const isZip = group.mode === 'zip';
  zipGroup.style.display = isZip ? 'block' : 'none';
  countryGroup.style.display = isZip ? 'none' : 'block';
  renderCountryOptions();
  resultCard.style.display = 'none';
}

groupSelect.addEventListener('change', switchGroup);

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
  });
});

// ---------- 计算结果 ----------
function renderResult(result) {
  const s = result.summary;
  resultCard.style.display = 'block';

  resultGrid.innerHTML = `
    <div class="result-item">
      <div class="label">目的地</div>
      <div class="value">${result.groupName} · ${result.destination}</div>
    </div>
    <div class="result-item">
      <div class="label">箱数</div>
      <div class="value">${s.boxCount} 箱</div>
    </div>
    <div class="result-item">
      <div class="label">起算重量${result.minWeightMode === 'per_box' ? '（多箱 · 每箱）' : '（一箱）'}</div>
      <div class="value">${result.minWeight} kg</div>
    </div>
    <div class="result-item">
      <div class="label">合计实重</div>
      <div class="value">${s.totalActualWeight} kg</div>
    </div>
    <div class="result-item">
      <div class="label">合计计费重</div>
      <div class="value">${s.totalChargedWeight} kg</div>
    </div>
    <div class="result-item">
      <div class="label">合计体积</div>
      <div class="value">${s.totalVolume} cm³</div>
    </div>
    <div class="result-item">
      <div class="label">基础运费合计</div>
      <div class="value">${formatMoney(s.totalBaseFreight)}</div>
    </div>
    <div class="result-item">
      <div class="label">附加费合计</div>
      <div class="value">${formatMoney(s.totalSurcharge)}</div>
    </div>
    <div class="result-item total">
      <div class="label">预估总运费（${s.boxCount} 箱合计）</div>
      <div class="value">${formatMoney(s.total)}</div>
    </div>
  `;

  boxDetailBody.innerHTML = result.boxes
    .map(
      b => `
      <tr>
        <td>${b.index}</td>
        <td>${b.sides}</td>
        <td>${b.girth}</td>
        <td>${b.volume}</td>
        <td>${b.actualWeight}</td>
        <td>${b.volWeight}</td>
        <td>${b.chargedWeight}</td>
        <td>${b.tierLabel}</td>
        <td>${formatMoney(b.unitPrice)}</td>
        <td>${formatMoney(b.baseFreight)}</td>
        <td>${formatMoney(b.surcharge)}</td>
        <td><strong>${formatMoney(b.total)}</strong></td>
      </tr>
    `
    )
    .join('');

  const details = result.boxes.filter(b => b.surchargeDetail && b.surchargeDetail.length);
  if (details.length) {
    surchargeDetail.style.display = 'block';
    // 每条附加费单独一行（原来用「；」串在一行里，规则一多就不好读）
    surchargeDetail.innerHTML =
      '<strong>附加费明细：</strong><ul class="surcharge-boxes">' +
      details
        .map(
          b =>
            `<li><span class="surcharge-box">第 ${b.index} 箱</span><ul>${b.surchargeDetail
              .map(d => `<li>${escapeHtml(d)}</li>`)
              .join('')}</ul></li>`
        )
        .join('') +
      '</ul>';
  } else {
    surchargeDetail.style.display = 'none';
  }
}

// 收集当前输入并计算；批量导入后可直接复用
async function runCalculate() {
  const group = currentGroupMeta();
  if (!group) return;
  const filled = getFilledBoxes();
  if (!filled.length) {
    showToast('请至少填写一个完整的箱规（长、宽、高、实重）');
    return;
  }

  const payload = { groupKey: group.key, boxes: filled };
  if (group.mode === 'zip') {
    if (!zipInput.value.trim()) {
      showToast('请输入美国邮编');
      return;
    }
    payload.zip = zipInput.value.trim();
  } else {
    payload.rowId = countrySelect.value;
  }

  try {
    const result = await api.calculate(payload);
    renderResult(result);
  } catch (err) {
    showToast(err.message || '计算失败');
  }
}

btnCalc.addEventListener('click', runCalculate);

// ---------- 价格管理 ----------
function renderGroupTabs() {
  groupTabs.innerHTML = '';
  config.groups.forEach(group => {
    const tab = document.createElement('div');
    tab.className = 'sub-tab' + (group.key === activeDataGroup ? ' active' : '');
    tab.textContent = group.name;
    tab.dataset.group = group.key;
    tab.addEventListener('click', () => {
      activeDataGroup = group.key;
      renderGroupTabs();
      renderGroupPanel();
    });
    groupTabs.appendChild(tab);
  });
}

function tierHeadHtml(group) {
  return group.tiers
    .map(
      tier => `
      <th>
        <input class="tier-input" type="number" step="0.1" min="0" data-tier="${tier.id}" value="${tier.min_weight}">
        <div class="hint">KG 起</div>
      </th>
    `
    )
    .join('');
}

function rateTableHtml(group) {
  const isZip = group.mode === 'zip';
  const placeholder = group.rows.some(row =>
    Object.keys(row.prices).every(key => Number(row.prices[key]) === 0)
  );

  return `
    <div class="section-title">${group.name} · 起算重量（最低计费重）</div>
    <div class="form-row">
      <div class="form-group">
        <label>一箱起算</label>
        <input type="number" step="0.1" min="0" data-field="minWeightSingle" value="${group.minWeightSingle}">
        <div class="hint">KG，只填 1 个箱时按这个数保底</div>
      </div>
      <div class="form-group">
        <label>多箱起算（每个箱）</label>
        <input type="number" step="0.1" min="0" data-field="minWeightPerBox" value="${group.minWeightPerBox}">
        <div class="hint">KG，填 2 个及以上箱时，每个箱各按这个数保底</div>
      </div>
    </div>
    <div class="section-title">${group.name} · 单价表</div>
    ${placeholder ? '<div class="warn">该目的地存在单价为 0 的行，请填写实际报价后再计算。</div>' : ''}
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th style="min-width:220px">${isZip ? '区域' : '国家 / 地区'}</th>
            ${isZip ? '<th>邮编开头</th>' : ''}
            ${tierHeadHtml(group)}
            <th style="width:90px">操作</th>
          </tr>
        </thead>
        <tbody>
          ${group.rows
            .map(
              row => `
            <tr data-row="${row.id}">
              <td><textarea data-field="name" rows="2">${escapeHtml(row.row_name)}</textarea></td>
              ${isZip ? `<td><input type="text" data-field="matchKey" value="${row.match_key || ''}"></td>` : ''}
              ${group.tiers
                .map(
                  tier =>
                    `<td><input type="number" step="0.1" min="0" data-field="price" data-tier="${tier.id}" value="${row.prices[tier.id]}"></td>`
                )
                .join('')}
              <td><button class="btn btn-danger btn-sm btn-delete-row">删除</button></td>
            </tr>
          `
            )
            .join('')}
        </tbody>
      </table>
    </div>
    <div class="actions">
      <button class="btn btn-primary btn-sm btn-add-row">+ 新增地区</button>
      <span class="hint">表头数字即各阶梯的起始重量（只决定单价档位）；最低计费重请到页面上方「起算重量」里设置。</span>
    </div>
  `;
}

function ruleTableHtml(group) {
  return `
    <div class="section-title">${group.name} · 附加费规则</div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th style="width:56px">序号</th>
            <th style="width:140px">规则组</th>
            <th style="width:100px">条件字段</th>
            <th style="width:130px">次级字段</th>
            <th style="width:110px">下限（≥）</th>
            <th style="width:110px">上限（&lt;）</th>
            <th style="width:110px">金额（元）</th>
            <th style="width:90px">操作</th>
          </tr>
        </thead>
        <tbody>
          ${group.rules
            .map(
              (rule, i) => `
            <tr data-rule="${i}">
              <td class="seq">#${i + 1}</td>
              <td><input type="text" data-field="rule_group" value="${escapeAttr(rule.rule_group)}"></td>
              <td>
                <select data-field="field_main">
                  ${FIELD_GROUPS.map(
                    g =>
                      `<option value="${g.key}" ${fieldGroupOf(rule.field).key === g.key ? 'selected' : ''}>${g.name}</option>`
                  ).join('')}
                </select>
              </td>
              <td>${subFieldOptions(rule)}</td>
              <td><input type="number" step="0.1" data-field="threshold" value="${rule.threshold}"></td>
              <td><input type="number" step="0.1" data-field="threshold_max" placeholder="不限" value="${
                rule.threshold_max === null || rule.threshold_max === undefined ? '' : rule.threshold_max
              }"></td>
              <td><input type="number" step="1" data-field="amount" value="${rule.amount}"></td>
              <td><button class="btn btn-danger btn-sm btn-delete-rule">删除</button></td>
            </tr>
          `
            )
            .join('')}
          ${
            group.rules.length
              ? ''
              : '<tr><td colspan="8" class="hint">暂无规则，点击「新增规则」添加。</td></tr>'
          }
        </tbody>
      </table>
    </div>
    <div class="actions">
      <button class="btn btn-primary btn-sm btn-add-rule">+ 新增规则</button>
      <span class="hint">序号 = 规则在本表中的位置（#N）。规则是否生效由下方决定：被任一「规则组组合」或「不叠加取最高」勾选即启用，两处都没勾的不参与计算。</span>
    </div>
    ${combinationsHtml(group)}
    ${maxRulesHtml(group)}
    <div class="form-row">
      <div class="form-group">
        <button class="btn btn-primary btn-save-group">保存「${group.name}」这一页</button>
        <div class="hint">改完必须点这里才会写入，否则只影响当前页面。</div>
      </div>
      <div class="form-group">
        <button class="btn btn-secondary btn-reload-group">重新加载已保存配置</button>
        <div class="hint">放弃这一页未保存的改动，回到最近一次保存的状态。</div>
      </div>
    </div>
  `;
}

// 组合是独立维护的列表：group.combos = [{ name, mode }]
// 规则靠 rule_group 归属到某个组合；规则表里填名字**不会**自动建组合
// 老数据（没有 combos 字段）从规则里推导一次并写回，保证无缝升级
function deriveCombosFromRules(rules) {
  const map = new Map(); // name → { name, mode, indexes }
  rules.forEach((r, i) => {
    const name = String(r.rule_group || '').trim();
    if (!name) return;
    if (!map.has(name)) {
      map.set(name, { name, mode: COMBINE_MODE_LABELS[r.combine_mode] ? r.combine_mode : 'add', indexes: [] });
    }
    map.get(name).indexes.push(i);
  });
  return Array.from(map.values());
}

function groupCombos(group) {
  if (!Array.isArray(group.combos)) group.combos = deriveCombosFromRules(group.rules);
  return group.combos;
}

// 「不叠加取最高」独立维护一组规则下标（优先级最高，不挂在组合下）
function groupMaxRules(group) {
  if (!Array.isArray(group.maxRules)) group.maxRules = [];
  return group.maxRules;
}

// 已经编入组合的规则下标（没编入的 = 不生效）
function comboMemberIdx(group) {
  const set = new Set();
  groupCombos(group).forEach(c => (c.indexes || []).forEach(i => set.add(i)));
  return set;
}

// 当前组合列表（下标过滤掉越界的）
function buildCombos(group) {
  return groupCombos(group).map(c => ({
    name: String(c.name || '').trim(),
    mode: COMBINE_MODE_LABELS[c.mode] ? c.mode : 'add',
    indexes: (c.indexes || []).filter(i => group.rules[i]),
  }));
}

// 写回：组合自己持有「名字 + 行为 + 成员下标」，不碰规则的 rule_group / combine_mode
// 空组合也要保留（刚「+ 新增组合」还没勾规则时不能消失）
function applyCombos(group, combos) {
  group.combos = combos.map(c => ({
    name: String(c.name || '').trim() || '(未命名)',
    mode: COMBINE_MODE_LABELS[c.mode] ? c.mode : 'add',
    indexes: Array.from(new Set(c.indexes || []))
      .filter(i => group.rules[i])
      .sort((a, b) => a - b),
  }));
}

// 规则组组合（新版）：每个组合一行，里面用复选框选规则
function combinationsHtml(group) {
  const combos = buildCombos(group);
  const members = comboMemberIdx(group);
  const maxPicked = new Set(groupMaxRules(group));
  const hasOrphans = group.rules.some((r, i) => !members.has(i));

  if (!group.rules.length) {
    return `
      <div class="section-title">${group.name} · 规则组组合</div>
      <div class="hint">还没有规则，先在上方添加。</div>
    `;
  }

  const rows = combos
    .map(
      (c, ci) => `
      <div class="combo-row" data-combo-idx="${ci}">
        <div class="combo-line">
          <input type="text" class="combo-name" data-field="combo_name" data-combo-idx="${ci}" value="${escapeAttr(c.name)}">
          <select data-field="combo_mode" data-combo-idx="${ci}">
            ${Object.keys(COMBINE_MODE_LABELS)
              .map(k => `<option value="${k}" ${c.mode === k ? 'selected' : ''}>${COMBINE_MODE_LABELS[k]}</option>`)
              .join('')}
          </select>
          <button class="btn btn-danger btn-sm btn-delete-combo" data-combo-idx="${ci}">删除组合</button>
        </div>
        <div class="combo-rules">
          ${group.rules.map((r, i) => `
            <label class="combo-cb${c.indexes.includes(i) ? ' is-on' : ''}">
              <input type="checkbox" data-field="combo_cb" data-combo-idx="${ci}" data-rule-idx="${i}" ${c.indexes.includes(i) ? 'checked' : ''}>
              <span class="combo-cb-num">#${i + 1}</span>
              <span class="combo-cb-desc">${escapeHtml(FIELD_LABELS[r.field] || r.field)} ${r.threshold_max != null && r.threshold_max !== '' ? `${r.threshold}≤&lt;${r.threshold_max}` : `≥${r.threshold}`}, ${r.amount} 元${
            maxPicked.has(i) ? ' <b class="max-tag">（归取最高）</b>' : ''
          }</span>
            </label>
          `).join('')}
        </div>
      </div>
    `
    )
    .join('');

  return `
    <div class="section-title">${group.name} · 规则组组合</div>
    <div class="hint">组合用下方「+ 新增组合」创建：填名字、选行为，再勾选规则（#序号）编入。<b>各组合互不联动</b>：改 A 不会影响 B，同一条规则也可以同时属于多个组合（按各自行为分别计算）。组合名与规则表的「规则组」列同样互不联动（规则组只是规则的备注名）；没被任何组合勾选的规则不参与计算。</div>
    <div class="combinations">
      ${rows || '<div class="hint">还没有组合，点「+ 新增组合」创建，再勾选规则编入。</div>'}
      <div class="combo-actions">
        <button class="btn btn-primary btn-sm btn-add-combo">+ 新增组合</button>
        ${hasOrphans ? '<span class="warn">有规则还没编入任何组合（未编入 = 不生效），勾到上面的组合里即可启用。</span>' : ''}
      </div>
    </div>
  `;
}

// 「不叠加取最高」独立区域：优先级最高，命中的规则里只收金额最高的一条
function maxRulesHtml(group) {
  const picked = new Set(groupMaxRules(group).filter(i => group.rules[i]));

  if (!group.rules.length) {
    return `
      <div class="section-title">${group.name} · 不叠加取最高（优先级最高）</div>
      <div class="hint">还没有规则，先在上方添加。</div>
    `;
  }

  const chips = group.rules
    .map(
      (r, i) => `
        <label class="combo-cb${picked.has(i) ? ' is-on' : ''}">
          <input type="checkbox" data-field="max_cb" data-rule-idx="${i}" ${picked.has(i) ? 'checked' : ''}>
          <span class="combo-cb-num">#${i + 1}</span>
          <span class="combo-cb-desc">${escapeHtml(FIELD_LABELS[r.field] || r.field)} ${
        r.threshold_max != null && r.threshold_max !== '' ? `${r.threshold}≤&lt;${r.threshold_max}` : `≥${r.threshold}`
      }, ${r.amount} 元</span>
        </label>
      `
    )
    .join('');

  return `
    <div class="section-title">${group.name} · 不叠加取最高（优先级最高）</div>
    <div class="hint">勾选的规则命中后，只收其中<b>金额最高</b>的那一条，并且所有<b>叠加 / 不叠加</b>组合的费用全部不计（卡派、提醒、拒收不受影响）。被勾选的规则不再按它所属的组合计算。</div>
    <div class="combinations">
      <div class="combo-row max-row">
        <div class="combo-rules">${chips}</div>
      </div>
      ${
        picked.size
          ? `<div class="combo-actions"><span class="warn">已选 ${picked.size} 条：命中时只收其中最高金额，叠加 / 不叠加组合全部不计。</span></div>`
          : '<div class="combo-actions"><span class="hint">还没勾选任何规则。</span></div>'
      }
    </div>
  `;
}

// 规则组组合方式：按规则组配置行为（同一组内所有规则共用一种行为）


function renderGroupPanel() {
  const group = config.groups.find(g => g.key === activeDataGroup);
  if (!group) return;
  groupPanels.innerHTML = '';
  const panel = document.createElement('div');
  panel.className = 'group-panel';
  panel.dataset.group = group.key;
  panel.innerHTML = dirtyBannerHtml(group) + rateTableHtml(group) + ruleTableHtml(group);
  groupPanels.appendChild(panel);
  updateDirtyIndicators();
}

function activeGroup() {
  return config.groups.find(g => g.key === activeDataGroup);
}

// 输入：直接改本地状态，等“保存”时统一提交
function handleDataInput(e) {
  const panel = e.target.closest('.group-panel');
  if (!panel) return;
  const group = config.groups.find(g => g.key === panel.dataset.group);
  if (!group) return;
  const field = e.target.dataset.field;

  if (e.target.classList.contains('tier-input')) {
    const tier = group.tiers.find(t => t.id === Number(e.target.dataset.tier));
    if (tier) tier.min_weight = Number(e.target.value);
    return;
  }

  // 起算重量（一箱 / 多箱每箱）
  if (field === 'minWeightSingle' || field === 'minWeightPerBox') {
    group[field] = e.target.value === '' ? 0 : Number(e.target.value);
    return;
  }

  // 「不叠加取最高」勾选：独立维护，与组合互不干扰（优先级最高）
  if (field === 'max_cb') {
    const idx = Number(e.target.dataset.ruleIdx);
    const set = new Set(groupMaxRules(group));
    if (e.target.checked) set.add(idx);
    else set.delete(idx);
    group.maxRules = Array.from(set)
      .filter(i => group.rules[i])
      .sort((a, b) => a - b);
    renderGroupPanel();
    return;
  }

  // 组合 checkbox：只改当前这个组合的成员，别的组合一概不动
  // （组合之间完全独立，同一条规则可以同时属于多个组合）
  if (field === 'combo_cb') {
    const ruleIdx = Number(e.target.dataset.ruleIdx);
    const comboIdx = Number(e.target.dataset.comboIdx);
    const combos = buildCombos(group);
    if (!combos[comboIdx]) combos[comboIdx] = { name: `组合${comboIdx + 1}`, indexes: [], mode: 'add' };
    const set = new Set(combos[comboIdx].indexes);
    if (e.target.checked) set.add(ruleIdx);
    else set.delete(ruleIdx);
    combos[comboIdx].indexes = Array.from(set).sort((a, b) => a - b);
    applyCombos(group, combos); // 空组合也保留，刚新增还没勾规则时不能消失
    renderGroupPanel();
    return;
  }

  // 组合改名 / 改行为：只改组合自己（不再回写成员规则的 rule_group / combine_mode）
  if (field === 'combo_name' || field === 'combo_mode') {
    const comboIdx = Number(e.target.dataset.comboIdx);
    const combos = buildCombos(group);
    if (!combos[comboIdx]) return;
    if (field === 'combo_name') combos[comboIdx].name = e.target.value || '(未命名)';
    if (field === 'combo_mode') combos[comboIdx].mode = COMBINE_MODE_LABELS[e.target.value] ? e.target.value : 'add';
    applyCombos(group, combos);
    // 改名要在失焦后才重绘（重绘会丢输入焦点）
    if (field === 'combo_name' ? e.type === 'change' : e.type === 'change') renderGroupPanel();
    return;
  }

  const ruleTr = e.target.closest('[data-rule]');
  if (ruleTr) {
    const rule = group.rules[Number(ruleTr.dataset.rule)];
    if (!rule) return;
    // 主字段切换：次级字段跟着换，默认取该类别的第一项（无次级字段时直接用主字段）
    if (field === 'field_main') {
      const picked = FIELD_GROUPS.find(g => g.key === e.target.value);
      if (picked) rule.field = picked.fields ? picked.fields[0].key : picked.key;
      renderGroupPanel();
      return;
    }
    if (field === 'field_sub') {
      if (e.target.value) rule.field = e.target.value;
      return;
    }
    if (field === 'threshold' || field === 'amount') rule[field] = Number(e.target.value);
    else if (field === 'threshold_max') rule[field] = e.target.value === '' ? null : Number(e.target.value);
    else rule[field] = e.target.value;
    // 规则组改名后，下方的「规则组组合方式」需要同步刷新（只在失焦时重绘，避免打断输入）
    if (field === 'rule_group' && e.type === 'change') renderGroupPanel();
    return;
  }

  const rowTr = e.target.closest('[data-row]');
  if (rowTr) {
    const row = group.rows.find(r => r.id === Number(rowTr.dataset.row));
    if (!row) return;
    if (field === 'name') row.row_name = e.target.value;
    else if (field === 'matchKey') row.match_key = e.target.value;
    else if (field === 'price') row.prices[Number(e.target.dataset.tier)] = Number(e.target.value);
  }
}

groupPanels.addEventListener('input', handleDataInput);
groupPanels.addEventListener('change', handleDataInput);

function collectGroup(group) {
  return {
    groupKey: group.key,
    minWeightSingle: Number(group.minWeightSingle),
    minWeightPerBox: Number(group.minWeightPerBox),
    tiers: group.tiers.map(t => ({ id: t.id, min_weight: Number(t.min_weight) })),
    // 「不叠加取最高」独立提交（优先级最高）
    maxRules: Array.from(new Set(groupMaxRules(group).filter(i => group.rules[i]))).sort((a, b) => a - b),
    // 组合列表（名字 + 行为 + 成员下标）独立提交，与规则表的规则组名无关
    combos: groupCombos(group).map(c => ({
      name: String(c.name || '').trim(),
      mode: COMBINE_MODE_LABELS[c.mode] ? c.mode : 'add',
      indexes: Array.from(new Set((c.indexes || []).filter(i => group.rules[i]))).sort((a, b) => a - b),
    })),
    rows: group.rows.map(row => ({
      id: row.id,
      name: row.row_name,
      matchKey: row.match_key,
      prices: Object.keys(row.prices).reduce((acc, tierId) => {
        acc[tierId] = Number(row.prices[tierId]);
        return acc;
      }, {}),
    })),
    rules: group.rules.map(rule => ({
      id: rule.id,
      rule_group: rule.rule_group,
      field: rule.field,
      threshold: Number(rule.threshold),
      threshold_max:
        rule.threshold_max === null || rule.threshold_max === undefined || rule.threshold_max === ''
          ? null
          : Number(rule.threshold_max),
      amount: Number(rule.amount),
      combine_mode: COMBINE_MODE_LABELS[rule.combine_mode] ? rule.combine_mode : 'add',
      // 规则表不再有「启用」列：是否生效由是否被组合勾选决定（未编入 = 不参与计算）
      enabled: 1,
    })),
  };
}

// ---------- 未保存改动的提醒 ----------
function groupSignature(group) {
  return JSON.stringify(collectGroup(group));
}

function rememberSaved(group) {
  if (group) savedSnapshots.set(group.key, groupSignature(group));
}

function isGroupDirty(group) {
  if (!group) return false;
  const saved = savedSnapshots.get(group.key);
  return saved !== undefined && saved !== groupSignature(group);
}

function isVolDivisorDirty() {
  return Number(volDivisorInput.value) !== Number(config.volDivisor);
}

function dirtyBannerHtml(group) {
  return `
    <div class="dirty-banner"${isGroupDirty(group) ? '' : ' hidden'}>
      <span class="dirty-dot"></span>
      <span>「${escapeHtml(group.name)}」有未保存的改动 —— 点下方「保存」才会生效；点「重新加载已保存配置」可以放弃这些改动。</span>
    </div>
  `;
}

// 打字时不能整块重绘（会丢焦点），只更新提醒
function updateDirtyIndicators() {
  const group = activeGroup();
  const dirty = isGroupDirty(group);
  const panel = groupPanels.querySelector('.group-panel');
  if (panel) {
    panel.classList.toggle('is-dirty', dirty);
    const banner = panel.querySelector('.dirty-banner');
    if (banner) banner.hidden = !dirty;
  }
  groupTabs.querySelectorAll('.sub-tab').forEach(tab => {
    tab.classList.toggle('is-dirty', isGroupDirty(config.groups.find(g => g.key === tab.dataset.group)));
  });
  btnSaveVol.classList.toggle('is-dirty', isVolDivisorDirty());
}

groupPanels.addEventListener('click', async e => {
  const group = activeGroup();
  if (!group) return;

  try {
    if (e.target.classList.contains('btn-add-row')) {
      const updated = await api.addRateRow({ groupKey: group.key, name: '新增地区' });
      Object.assign(group, updated);
      renderGroupPanel();
      showToast('已新增地区，请填写名称与单价后保存');
    } else if (e.target.classList.contains('btn-delete-row')) {
      const rowId = e.target.closest('[data-row]').dataset.row;
      const updated = await api.deleteRateRow({ groupKey: group.key, rowId });
      Object.assign(group, updated);
      renderGroupPanel();
      showToast('地区已删除');
    } else if (e.target.classList.contains('btn-add-rule')) {
      group.rules.push({
        id: null,
        rule_group: '', // 默认未编入组合（= 不生效），需到下方组合里勾选
        field: 'girth',
        threshold: 0,
        threshold_max: null,
        amount: 0,
        combine_mode: 'add',
        enabled: 1,
      });
      renderGroupPanel();
    } else if (e.target.classList.contains('btn-delete-rule')) {
      const index = Number(e.target.closest('[data-rule]').dataset.rule);
      group.rules.splice(index, 1);
      // 规则下标整体前移，组合与「不叠加取最高」的成员下标都要跟着重排
      group.maxRules = groupMaxRules(group)
        .filter(i => i !== index)
        .map(i => (i > index ? i - 1 : i));
      applyCombos(
        group,
        groupCombos(group).map(c => ({
          ...c,
          indexes: (c.indexes || [])
            .filter(i => i !== index)
            .map(i => (i > index ? i - 1 : i)),
        }))
      );
      renderGroupPanel();
    } else if (e.target.classList.contains('btn-add-combo')) {
      // 只创建空组合，成员由下方复选框勾选（不再自动把未分组规则塞进来）
      const usedNames = new Set(groupCombos(group).map(c => c.name));
      let name = '新组合';
      let i = 2;
      while (usedNames.has(name)) { name = '新组合' + (i++); }
      groupCombos(group).push({ name, mode: 'add', indexes: [] });
      renderGroupPanel();
      showToast('已新增组合：填名字、选行为并勾选规则后保存');
    } else if (e.target.classList.contains('btn-delete-combo')) {
      const comboIdx = Number(e.target.dataset.comboIdx);
      // 只删组合本身；成员规则的「规则组」名保持不动（两边不联动），但会变回未编入 = 不生效
      if (buildCombos(group)[comboIdx]) groupCombos(group).splice(comboIdx, 1);
      renderGroupPanel();
    } else if (e.target.classList.contains('btn-save-group')) {
      const updated = await api.saveGroup(collectGroup(group));
      Object.assign(group, updated);
      rememberSaved(group); // 保存成功 = 新的基准状态
      renderGroupPanel();
      renderCountryOptions();
      showToast(`「${group.name}」已保存`);
    } else if (e.target.classList.contains('btn-reload-group')) {
      // 重新加载：丢掉本页未保存的改动，回到最近一次保存的状态
      if (isGroupDirty(group) && !confirm(`「${group.name}」有未保存的改动，重新加载会丢弃这些改动，确定继续吗？`)) {
        return;
      }
      const saved = await api.getGroupConfig(group.key);
      Object.assign(group, saved);
      rememberSaved(group);
      renderGroupTabs();
      renderGroupPanel();
      renderCountryOptions();
      showToast(`已重新加载「${group.name}」最近一次保存的配置`);
    }
  } catch (err) {
    showToast(err.message || '操作失败');
  }
});

btnSaveVol.addEventListener('click', async () => {
  const value = Number(volDivisorInput.value);
  if (!value || value <= 0) {
    showToast('体积重系数必须大于 0');
    return;
  }
  await api.setVolDivisor(value);
  config.volDivisor = value;
  updateDirtyIndicators();
  showToast('体积重系数已保存');
});

// 打字 / 勾选后只刷新提醒，不重绘（重绘会丢焦点）
groupPanels.addEventListener('input', updateDirtyIndicators);
groupPanels.addEventListener('change', updateDirtyIndicators);
volDivisorInput.addEventListener('input', updateDirtyIndicators);

// 关页面 / 刷新前兜底提醒
window.addEventListener('beforeunload', e => {
  const dirty = config.groups.some(isGroupDirty) || isVolDivisorDirty();
  if (!dirty) return;
  e.preventDefault();
  e.returnValue = '';
});

btnReset.addEventListener('click', async () => {
  if (!confirm('确定要恢复默认数据吗？所有自定义价格与规则都会丢失。')) return;
  await api.resetDatabase();
  config = await api.getConfig();
  refreshData();
  switchGroup();
  showToast('已恢复默认数据');
});

// ---------- 配置导出 / 导入 ----------
const btnExport = document.getElementById('btn-export');
const btnImport = document.getElementById('btn-import');

btnExport.addEventListener('click', async () => {
  try {
    const res = await api.exportConfig();
    if (res.ok) showToast('配置已导出：' + res.filePath);
  } catch (err) {
    showToast(err.message || '导出失败');
  }
});

btnImport.addEventListener('click', async () => {
  if (!confirm('导入会覆盖当前所有价格、规则与起算重量，确定继续吗？')) return;
  try {
    const res = await api.importConfig();
    if (!res.ok) return;
    config = res.config;
    refreshData();
    switchGroup();
    showToast('配置已导入：' + res.filePath);
  } catch (err) {
    showToast(err.message || '导入失败');
  }
});

// ---------- 启动 ----------
let activeDataGroup = 'us';

function refreshData() {
  volDivisorInput.value = config.volDivisor;
  if (!config.groups.some(g => g.key === activeDataGroup)) activeDataGroup = config.groups[0].key;
  // 刚读进来的就是「已保存」状态，作为比对基准
  config.groups.forEach(rememberSaved);
  renderGroupOptions();
  renderGroupTabs();
  renderGroupPanel();
  updateDirtyIndicators();
}

async function init() {
  config = await api.getConfig();
  refreshData();
  switchGroup();
  renderBoxes();
}

init();
