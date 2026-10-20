const api = window.freightApi;

const MAX_BOXES = 10;

const FIELD_LABELS = {
  weight: '实重 (KG)',
  charged_weight: '计费重 (KG)',
  girth: '围长 (CM)',
  longest: '最长边 (CM)',
  second_longest: '次长边 (CM)',
  shortest: '最短边 (CM)',
  volume: '体积 (CM³)',
};

// 附加费行为：逐条规则配置，取代原来的「类型 + 国家级叠加方式」
const COMBINE_MODE_LABELS = {
  add: '叠加（与其他叠加组求和）',
  not_stack: '不叠加（自身累加，不影响叠加组）',
  max: '不叠加取最高（命中后只收本类最高）',
  cardispatch: '卡派（独立累加）',
  notice: '提醒（不收费）',
  reject: '拒收（达到即不收货）',
};

const COMBINE_MODE_HINTS = {
  add: '同一个规则组内满足任一条件只收一次（取组内最高）；不同规则组之间相加。',
  not_stack: '同样按规则组去重后累加，但不会被「不叠加取最高」替换掉。',
  max: '命中任意一条「不叠加取最高」规则后，只收这类里的最高金额，其余叠加/不叠加规则全部不计。',
  cardispatch: '卡车派送等固定费用，单独累加，不受「不叠加取最高」影响。',
  notice: '不产生费用，只在结果里给出提示。',
  reject: '命中即视为超出承运范围，计算时直接报错。',
};

let config = { volDivisor: 6000, groups: [] };
let boxes = [createBox()];

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
    surchargeDetail.innerHTML =
      '<strong>附加费明细：</strong><ul>' +
      details.map(b => `<li>第 ${b.index} 箱：${b.surchargeDetail.join('；')}</li>`).join('') +
      '</ul>';
  } else {
    surchargeDetail.style.display = 'none';
  }
}

btnCalc.addEventListener('click', async () => {
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
});

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
            <th style="width:60px">序号</th>
            <th style="width:140px">规则组</th>
            <th style="width:150px">条件字段</th>
            <th style="width:110px">下限（≥）</th>
            <th style="width:110px">上限（&lt;）</th>
            <th style="width:110px">金额（元）</th>
            <th style="width:70px">启用</th>
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
                <select data-field="field">
                  ${Object.keys(FIELD_LABELS)
                    .map(
                      f =>
                        `<option value="${f}" ${rule.field === f ? 'selected' : ''}>${FIELD_LABELS[f]}</option>`
                    )
                    .join('')}
                </select>
              </td>
              <td><input type="number" step="0.1" data-field="threshold" value="${rule.threshold}"></td>
              <td><input type="number" step="0.1" data-field="threshold_max" placeholder="不限" value="${
                rule.threshold_max === null || rule.threshold_max === undefined ? '' : rule.threshold_max
              }"></td>
              <td><input type="number" step="1" data-field="amount" value="${rule.amount}"></td>
              <td><input type="checkbox" data-field="enabled" ${Number(rule.enabled) === 1 ? 'checked' : ''}></td>
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
      <span class="hint">序号 = 规则在本表中的位置（#N）。下方「规则组组合」用复选框把规则编入各组合并设置行为。</span>
    </div>
    ${combinationsHtml(group)}
    <div class="form-row">
      <div class="form-group">
        <button class="btn btn-primary btn-save-group">保存「${group.name}」这一页</button>
      </div>
    </div>
  `;
}

// 把规则按当前的 rule_group 字段聚成组合
function buildCombos(group) {
  const map = new Map(); // name → {name, indexes, mode}
  group.rules.forEach((r, i) => {
    const name = r.rule_group || '';
    if (!name) return;
    if (!map.has(name)) map.set(name, { name, indexes: [], mode: r.combine_mode || 'add' });
    map.get(name).indexes.push(i);
  });
  return Array.from(map.values()).filter(c => c.indexes.length > 0);
}

// 把组合写回规则（rule_group / combine_mode）
function applyCombos(group, combos) {
  combos.forEach(combo => {
    combo.indexes.forEach(idx => {
      const r = group.rules[idx];
      if (!r) return;
      r.rule_group = combo.name;
      r.combine_mode = combo.mode;
    });
  });
}

// 规则组组合（新版）：每个组合一行，里面用复选框选规则
function combinationsHtml(group) {
  const combos = buildCombos(group);
  const hasOrphans = group.rules.some(r => !r.rule_group);

  if (!group.rules.length) {
    return `
      <div class="section-title">${group.name} · 规则组组合</div>
      <div class="hint">还没有规则，先在上方添加。</div>
    `;
  }

  const ruleChip = (r, i) => {
    const range = r.threshold_max !== null && r.threshold_max !== undefined && r.threshold_max !== ''
      ? `${r.threshold}≤&lt;${r.threshold_max}`
      : `≥${r.threshold}`;
    return `
      <label class="combo-cb">
        <input type="checkbox" data-field="combo_cb" data-rule-idx="${i}">
        <span class="combo-cb-num">#${i + 1}</span>
        <span class="combo-cb-desc">${escapeHtml(FIELD_LABELS[r.field] || r.field)} ${range}, ${r.amount} 元</span>
      </label>
    `;
  };

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
              <span class="combo-cb-desc">${escapeHtml(FIELD_LABELS[r.field] || r.field)} ${r.threshold_max != null && r.threshold_max !== '' ? `${r.threshold}≤&lt;${r.threshold_max}` : `≥${r.threshold}`}, ${r.amount} 元</span>
            </label>
          `).join('')}
        </div>
      </div>
    `
    )
    .join('');

  return `
    <div class="section-title">${group.name} · 规则组组合</div>
    <div class="hint">勾选规则（#序号）以加入当前组合；同一规则只能勾在一个组合里（勾到新组合时自动从旧组合移走）。不同组合按各自行为合并。</div>
    <div class="combinations">
      ${rows}
      <div class="combo-actions">
        <button class="btn btn-primary btn-sm btn-add-combo">+ 新增组合</button>
        ${hasOrphans ? '<span class="warn">有未分组的规则（在规则表里给「规则组」列填个名字即可归入）。</span>' : ''}
      </div>
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
  panel.innerHTML = rateTableHtml(group) + ruleTableHtml(group);
  groupPanels.appendChild(panel);
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

  // 组合 checkbox：把规则移进/移出该组合
  if (field === 'combo_cb') {
    const ruleIdx = Number(e.target.dataset.ruleIdx);
    const comboIdx = Number(e.target.dataset.comboIdx);
    const combos = buildCombos(group);
    // 先把这一规则从任何已有组合中移除
    combos.forEach(c => {
      c.indexes = c.indexes.filter(i => i !== ruleIdx);
    });
    // 勾上则加入该组合
    if (e.target.checked) {
      if (!combos[comboIdx]) combos[comboIdx] = { name: `组合${comboIdx + 1}`, indexes: [], mode: 'add' };
      combos[comboIdx].indexes.push(ruleIdx);
      combos[comboIdx].indexes.sort((a, b) => a - b);
    }
    applyCombos(group, combos.filter(c => c.indexes.length));
    renderGroupPanel();
    return;
  }

  // 组合改名 / 改行为：批量更新成员规则
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
    if (field === 'enabled') rule[field] = e.target.checked ? 1 : 0;
    else if (field === 'threshold' || field === 'amount') rule[field] = Number(e.target.value);
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
      enabled: Number(rule.enabled) === 1 ? 1 : 0,
    })),
  };
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
        rule_group: '新规则',
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
      renderGroupPanel();
    } else if (e.target.classList.contains('btn-add-combo')) {
      // 新增组合：默认加到规则表末尾（避免空名）
      const usedNames = new Set(buildCombos(group).map(c => c.name));
      let name = '新组合';
      let i = 2;
      while (usedNames.has(name)) { name = '新组合' + (i++); }
      // 临时策略：先创建一个空组合行。把任意未分组规则丢进来
      const orphans = group.rules
        .map((r, idx) => ({ r, idx }))
        .filter(({ r }) => !r.rule_group);
      if (orphans.length) {
        orphans.forEach(({ r }) => (r.rule_group = name));
      }
      renderGroupPanel();
    } else if (e.target.classList.contains('btn-delete-combo')) {
      const comboIdx = Number(e.target.dataset.comboIdx);
      const combos = buildCombos(group);
      // 删除该组合，其余规则保留原状态（解组后将变"未组合"显示，但保留 rule_group 不动以免破坏）
      const removed = combos.splice(comboIdx, 1)[0];
      if (removed) {
        // 把该组合名清空，避免遗留歧义
        removed.indexes.forEach(idx => {
          if (group.rules[idx]) group.rules[idx].rule_group = '';
        });
      }
      renderGroupPanel();
    } else if (e.target.classList.contains('btn-save-group')) {
      const updated = await api.saveGroup(collectGroup(group));
      Object.assign(group, updated);
      renderGroupPanel();
      renderCountryOptions();
      showToast(`「${group.name}」已保存`);
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
  showToast('体积重系数已保存');
});

btnReset.addEventListener('click', async () => {
  if (!confirm('确定要恢复默认数据吗？所有自定义价格与规则都会丢失。')) return;
  await api.resetDatabase();
  config = await api.getConfig();
  refreshData();
  switchGroup();
  showToast('已恢复默认数据');
});

// ---------- 启动 ----------
let activeDataGroup = 'us';

function refreshData() {
  volDivisorInput.value = config.volDivisor;
  if (!config.groups.some(g => g.key === activeDataGroup)) activeDataGroup = config.groups[0].key;
  renderGroupOptions();
  renderGroupTabs();
  renderGroupPanel();
}

async function init() {
  config = await api.getConfig();
  refreshData();
  switchGroup();
  renderBoxes();
}

init();
