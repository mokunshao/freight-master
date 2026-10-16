const api = window.freightApi;

let usRates = [];
let euRates = [];
let euRules = [];
let boxes = [createBox()];

const regionSelect = document.getElementById('region');
const zipGroup = document.getElementById('zip-group');
const countryGroup = document.getElementById('country-group');
const countrySelect = document.getElementById('country');
const zipInput = document.getElementById('zip');

const boxesBody = document.getElementById('boxes-body');
const btnAddBox = document.getElementById('btn-add-box');
const btnClearBoxes = document.getElementById('btn-clear-boxes');
const btnCalc = document.getElementById('btn-calc');

const resultCard = document.getElementById('result');
const resultGrid = document.getElementById('result-grid');
const boxDetailBody = document.getElementById('box-detail-body');
const surchargeDetail = document.getElementById('surcharge-detail');

const usTableBody = document.getElementById('us-table-body');
const euTableBody = document.getElementById('eu-table-body');
const btnSaveAll = document.getElementById('btn-save-all');
const btnReset = document.getElementById('btn-reset');

const volDivisorInput = document.getElementById('vol-divisor');
const usInputs = {
  oversize_girth: document.getElementById('us-oversize-girth'),
  oversize_volume: document.getElementById('us-oversize-volume'),
  oversize_weight: document.getElementById('us-oversize-weight'),
  oversize_fee: document.getElementById('us-oversize-fee'),
  weight_threshold: document.getElementById('us-weight-threshold'),
  weight_fee: document.getElementById('us-weight-fee'),
  girth_threshold: document.getElementById('us-girth-threshold'),
  girth_fee: document.getElementById('us-girth-fee'),
  side_long_threshold: document.getElementById('us-side-long'),
  side_second_threshold: document.getElementById('us-side-second'),
  side_fee: document.getElementById('us-side-fee'),
};
const btnSaveSettings = document.getElementById('btn-save-settings');
const euRuleBody = document.getElementById('eu-rule-body');
const btnAddEuRule = document.getElementById('btn-add-eu-rule');

const toast = document.getElementById('toast');

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}

function formatMoney(n) {
  return '¥' + Number(n).toFixed(2);
}

// ---------- 箱子 ----------
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
  boxes.push(createBox());
  renderBoxes();
});

btnClearBoxes.addEventListener('click', () => {
  boxes = [createBox()];
  renderBoxes();
  resultCard.style.display = 'none';
});

function switchRegion() {
  const region = regionSelect.value;
  if (region === 'us') {
    zipGroup.style.display = 'block';
    countryGroup.style.display = 'none';
  } else {
    zipGroup.style.display = 'none';
    countryGroup.style.display = 'block';
  }
  resultCard.style.display = 'none';
}

regionSelect.addEventListener('change', switchRegion);

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
  });
});

// ---------- 结果渲染 ----------
function renderResult(result, isUs) {
  const s = result.summary;
  resultCard.style.display = 'block';

  resultGrid.innerHTML = `
    <div class="result-item">
      <div class="label">${isUs ? '邮编分区' : '国家'}</div>
      <div class="value">${isUs ? result.region : result.country}</div>
    </div>
    <div class="result-item">
      <div class="label">箱数</div>
      <div class="value">${s.boxCount} 箱</div>
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
        <td>${b.chargedWeight}</td>
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
  const region = regionSelect.value;
  const filled = getFilledBoxes();

  try {
    if (region === 'us') {
      const zip = zipInput.value.trim();
      if (!zip) {
        showToast('请输入美国邮编');
        return;
      }
      if (!filled.length) {
        showToast('请至少填写一个完整的箱子（长、宽、高、实重）');
        return;
      }
      const result = await api.calculateUs({ zip, boxes: filled });
      renderResult(result, true);
    } else {
      const countryId = countrySelect.value;
      if (!filled.length) {
        showToast('请至少填写一个完整的箱子（长、宽、高、实重）');
        return;
      }
      const result = await api.calculateEu({ countryId, boxes: filled });
      renderResult(result, false);
    }
  } catch (err) {
    showToast(err.message || '计算失败');
  }
});

// ---------- 价格表 ----------
async function loadData() {
  usRates = await api.getUsRates();
  euRates = await api.getEuRates();
  renderCountryOptions();
  renderUsTable();
  renderEuTable();
}

function renderCountryOptions() {
  const current = countrySelect.value;
  countrySelect.innerHTML = '';
  euRates.forEach(rate => {
    const option = document.createElement('option');
    option.value = rate.id;
    option.textContent = rate.country_name;
    countrySelect.appendChild(option);
  });
  if (current) countrySelect.value = current;
}

function renderUsTable() {
  usTableBody.innerHTML = '';
  usRates.forEach(rate => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${rate.region_name}</td>
      <td>${rate.zip_prefixes}</td>
      <td><input type="number" step="0.1" value="${rate.weight_10}" data-id="${rate.id}" data-field="weight_10"></td>
      <td><input type="number" step="0.1" value="${rate.weight_21}" data-id="${rate.id}" data-field="weight_21"></td>
      <td><input type="number" step="0.1" value="${rate.weight_71}" data-id="${rate.id}" data-field="weight_71"></td>
      <td><input type="number" step="0.1" value="${rate.weight_101}" data-id="${rate.id}" data-field="weight_101"></td>
      <td><button class="btn btn-primary btn-sm btn-save-row" data-id="${rate.id}">保存</button></td>
    `;
    usTableBody.appendChild(tr);
  });
}

function renderEuTable() {
  euTableBody.innerHTML = '';
  euRates.forEach(rate => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="text-align:left;">${rate.country_name}</td>
      <td><input type="number" step="0.1" value="${rate.weight_10}" data-id="${rate.id}" data-field="weight_10" data-type="eu"></td>
      <td><input type="number" step="0.1" value="${rate.weight_21}" data-id="${rate.id}" data-field="weight_21" data-type="eu"></td>
      <td><input type="number" step="0.1" value="${rate.weight_101}" data-id="${rate.id}" data-field="weight_101" data-type="eu"></td>
      <td><button class="btn btn-primary btn-sm btn-save-row" data-id="${rate.id}" data-type="eu">保存</button></td>
    `;
    euTableBody.appendChild(tr);
  });
}

function getRowInputs(type, id) {
  const inputs =
    type === 'us'
      ? usTableBody.querySelectorAll(`input[data-id="${id}"]`)
      : euTableBody.querySelectorAll(`input[data-id="${id}"]`);
  const data = { id: Number(id) };
  inputs.forEach(input => {
    data[input.dataset.field] = Number(input.value);
  });
  return data;
}

async function saveUsRow(id) {
  const data = getRowInputs('us', id);
  await api.updateUsRate(data);
  const idx = usRates.findIndex(r => r.id === Number(id));
  Object.assign(usRates[idx], data);
  showToast('美国价格已保存');
}

async function saveEuRow(id) {
  const data = getRowInputs('eu', id);
  await api.updateEuRate(data);
  const idx = euRates.findIndex(r => r.id === Number(id));
  Object.assign(euRates[idx], data);
  showToast('欧洲价格已保存');
}

async function saveAll() {
  const usPromises = usRates.map(r => saveUsRow(r.id));
  const euPromises = euRates.map(r => saveEuRow(r.id));
  await Promise.all([...usPromises, ...euPromises]);
  showToast('全部价格已保存');
}

usTableBody.addEventListener('click', async e => {
  if (e.target.classList.contains('btn-save-row')) {
    await saveUsRow(e.target.dataset.id);
  }
});

euTableBody.addEventListener('click', async e => {
  if (e.target.classList.contains('btn-save-row')) {
    await saveEuRow(e.target.dataset.id);
  }
});

btnSaveAll.addEventListener('click', saveAll);

btnReset.addEventListener('click', async () => {
  if (!confirm('确定要恢复默认数据吗？所有自定义价格与规则配置将丢失。')) return;
  await api.resetDatabase();
  await loadData();
  await loadSettings();
  showToast('已恢复默认数据');
});

// ---------- 计费与附加费规则 ----------
async function loadSettings() {
  const settings = await api.getSettings();
  volDivisorInput.value = settings.volDivisor;
  Object.keys(usInputs).forEach(key => {
    usInputs[key].value = settings.usSurcharge[key];
  });
  euRules = settings.euRules;
  renderEuRules();
}

function renderEuRules() {
  euRuleBody.innerHTML = '';
  euRules.forEach(rule => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <select data-id="${rule.id}" data-field="rule_type">
          <option value="girth" ${rule.rule_type === 'girth' ? 'selected' : ''}>围长 ≥</option>
          <option value="weight" ${rule.rule_type === 'weight' ? 'selected' : ''}>实重 ≥</option>
        </select>
      </td>
      <td><input type="number" step="0.1" data-id="${rule.id}" data-field="threshold" value="${rule.threshold}"></td>
      <td><input type="number" step="1" data-id="${rule.id}" data-field="amount" value="${rule.amount}"></td>
      <td><input type="checkbox" data-id="${rule.id}" data-field="enabled" ${Number(rule.enabled) === 1 ? 'checked' : ''}></td>
      <td>
        <button class="btn btn-primary btn-sm btn-save-rule" data-id="${rule.id}">保存</button>
        <button class="btn btn-danger btn-sm btn-delete-rule" data-id="${rule.id}">删除</button>
      </td>
    `;
    euRuleBody.appendChild(tr);
  });

  if (!euRules.length) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="5" class="hint">暂无规则，点击「新增规则」添加。</td>';
    euRuleBody.appendChild(tr);
  }
}

function getRuleInputs(id) {
  const pick = field => euRuleBody.querySelector(`[data-id="${id}"][data-field="${field}"]`);
  return {
    id: Number(id),
    rule_type: pick('rule_type').value,
    threshold: Number(pick('threshold').value),
    amount: Number(pick('amount').value),
    enabled: pick('enabled').checked ? 1 : 0,
  };
}

btnSaveSettings.addEventListener('click', async () => {
  const payload = {
    volDivisor: Number(volDivisorInput.value),
    usSurcharge: {},
  };
  Object.keys(usInputs).forEach(key => {
    payload.usSurcharge[key] = Number(usInputs[key].value);
  });
  await api.updateSettings(payload);
  showToast('计费参数与美国附加费已保存');
});

euRuleBody.addEventListener('click', async e => {
  const id = e.target.dataset.id;
  if (!id) return;
  try {
    if (e.target.classList.contains('btn-save-rule')) {
      euRules = await api.updateEuRule(getRuleInputs(id));
      renderEuRules();
      showToast('欧洲规则已保存');
    } else if (e.target.classList.contains('btn-delete-rule')) {
      euRules = await api.deleteEuRule({ id: Number(id) });
      renderEuRules();
      showToast('欧洲规则已删除');
    }
  } catch (err) {
    showToast(err.message || '操作失败');
  }
});

btnAddEuRule.addEventListener('click', async () => {
  euRules = await api.addEuRule();
  renderEuRules();
  showToast('已新增规则，记得修改阈值与金额后保存');
});

// ---------- 启动 ----------
renderBoxes();
loadData();
loadSettings();
