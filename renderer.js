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

const KIND_LABELS = {
  fee: '附加费（可叠加）',
  oversize: '附加费（超大件，命中不叠加）',
  reject: '达到即不收货',
  notice: '仅提醒（不收费）',
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
      <div class="label">起重</div>
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
              <td><textarea data-field="name" rows="2">${row.row_name}</textarea></td>
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
      <span class="hint">表头数字即各阶梯的起始重量，第一栏就是起重（计费重不足时按起重计算）。</span>
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
            <th style="width:140px">规则组</th>
            <th style="width:150px">条件字段</th>
            <th style="width:110px">下限（≥）</th>
            <th style="width:110px">上限（&lt;）</th>
            <th style="width:110px">金额（元）</th>
            <th style="width:200px">类型</th>
            <th style="width:70px">启用</th>
            <th style="width:90px">操作</th>
          </tr>
        </thead>
        <tbody>
          ${group.rules
            .map(
              (rule, i) => `
            <tr data-rule="${i}">
              <td><input type="text" data-field="rule_group" value="${rule.rule_group}"></td>
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
              <td>
                <select data-field="kind">
                  ${Object.keys(KIND_LABELS)
                    .map(
                      k =>
                        `<option value="${k}" ${(rule.kind || 'fee') === k ? 'selected' : ''}>${KIND_LABELS[k]}</option>`
                    )
                    .join('')}
                </select>
              </td>
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
      <span class="hint">条件 = 下限（≥）到上限（&lt;）的区间，上限留空表示不限；同一规则组内满足任一条件只收一次；不同规则组按下方模式处理。</span>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>附加费叠加方式</label>
        <select class="mode-select">
          <option value="stack" ${group.surchargeMode === 'stack' ? 'selected' : ''}>叠加（命中超大件时只收超大件）</option>
          <option value="max" ${group.surchargeMode === 'max' ? 'selected' : ''}>不叠加，取金额最高</option>
        </select>
      </div>
      <div class="form-group">
        <button class="btn btn-primary btn-save-group">保存「${group.name}」这一页</button>
      </div>
    </div>
  `;
}

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

  if (e.target.classList.contains('mode-select')) {
    group.surchargeMode = e.target.value;
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
    surchargeMode: group.surchargeMode,
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
      kind: rule.kind || 'fee',
      exclusive: rule.kind === 'oversize' ? 1 : 0,
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
        kind: 'fee',
        enabled: 1,
      });
      renderGroupPanel();
    } else if (e.target.classList.contains('btn-delete-rule')) {
      const index = Number(e.target.closest('[data-rule]').dataset.rule);
      group.rules.splice(index, 1);
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
