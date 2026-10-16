const api = window.freightApi;

let usRates = [];
let euRates = [];

const regionSelect = document.getElementById('region');
const zipGroup = document.getElementById('zip-group');
const countryGroup = document.getElementById('country-group');
const countrySelect = document.getElementById('country');
const zipInput = document.getElementById('zip');
const lengthInput = document.getElementById('length');
const widthInput = document.getElementById('width');
const heightInput = document.getElementById('height');
const weightInput = document.getElementById('weight');
const btnCalc = document.getElementById('btn-calc');
const resultCard = document.getElementById('result');
const resultGrid = document.getElementById('result-grid');
const surchargeDetail = document.getElementById('surcharge-detail');
const usTableBody = document.getElementById('us-table-body');
const euTableBody = document.getElementById('eu-table-body');
const btnSaveAll = document.getElementById('btn-save-all');
const btnReset = document.getElementById('btn-reset');
const toast = document.getElementById('toast');

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}

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

async function loadData() {
  usRates = await api.getUsRates();
  euRates = await api.getEuRates();
  renderCountryOptions();
  renderUsTable();
  renderEuTable();
}

function renderCountryOptions() {
  countrySelect.innerHTML = '';
  euRates.forEach(rate => {
    const option = document.createElement('option');
    option.value = rate.id;
    option.textContent = rate.country_name;
    countrySelect.appendChild(option);
  });
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
      <td><button class="btn btn-primary btn-save-row" data-id="${rate.id}">保存</button></td>
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
      <td><button class="btn btn-primary btn-save-row" data-id="${rate.id}" data-type="eu">保存</button></td>
    `;
    euTableBody.appendChild(tr);
  });
}

function getRowInputs(type, id) {
  const selector = `input[data-type="${type}"][data-id="${id}"]`;
  const inputs = type === 'us'
    ? document.querySelectorAll(`#us-table-body input[data-id="${id}"]`)
    : document.querySelectorAll(`#eu-table-body input[data-id="${id}"]`);
  const data = { id: Number(id) };
  inputs.forEach(input => {
    data[input.dataset.field] = Number(input.value);
  });
  return data;
}

async function saveUsRow(id) {
  const data = getRowInputs('us', id);
  await api.updateUsRate(data);
  const idx = usRates.findIndex(r => r.id === id);
  Object.assign(usRates[idx], data);
  showToast('美国价格已保存');
}

async function saveEuRow(id) {
  const data = getRowInputs('eu', id);
  await api.updateEuRate(data);
  const idx = euRates.findIndex(r => r.id === id);
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
  if (!confirm('确定要恢复默认数据吗？所有自定义价格将丢失。')) return;
  await api.resetDatabase();
  await loadData();
  showToast('已恢复默认数据');
});

function formatMoney(n) {
  return '¥' + Number(n).toFixed(2);
}

function renderResult(result, isUs) {
  resultCard.style.display = 'block';
  resultGrid.innerHTML = `
    <div class="result-item">
      <div class="label">${isUs ? '邮编分区' : '国家'}</div>
      <div class="value">${isUs ? result.region : result.country}</div>
    </div>
    <div class="result-item">
      <div class="label">箱规</div>
      <div class="value">${result.sides} cm</div>
    </div>
    <div class="result-item">
      <div class="label">围长</div>
      <div class="value">${result.girth} cm</div>
    </div>
    <div class="result-item">
      <div class="label">体积</div>
      <div class="value">${result.volume} cm³</div>
    </div>
    <div class="result-item">
      <div class="label">实重</div>
      <div class="value">${result.actualWeight} kg</div>
    </div>
    <div class="result-item">
      <div class="label">计费重（向上取整）</div>
      <div class="value">${result.chargedWeight} kg</div>
    </div>
    <div class="result-item">
      <div class="label">对应单价</div>
      <div class="value">${formatMoney(result.unitPrice)} / kg</div>
    </div>
    <div class="result-item">
      <div class="label">基础运费</div>
      <div class="value">${formatMoney(result.baseFreight)}</div>
    </div>
    <div class="result-item">
      <div class="label">附加费</div>
      <div class="value">${formatMoney(result.surcharge)}</div>
    </div>
    <div class="result-item total">
      <div class="label">预估总运费</div>
      <div class="value">${formatMoney(result.total)}</div>
    </div>
  `;

  if (result.surchargeDetail && result.surchargeDetail.length) {
    surchargeDetail.style.display = 'block';
    surchargeDetail.innerHTML = '<strong>附加费明细：</strong><ul>' +
      result.surchargeDetail.map(d => `<li>${d}</li>`).join('') +
      '</ul>';
  } else {
    surchargeDetail.style.display = 'none';
  }
}

btnCalc.addEventListener('click', async () => {
  const region = regionSelect.value;
  const length = Number(lengthInput.value);
  const width = Number(widthInput.value);
  const height = Number(heightInput.value);
  const weight = Number(weightInput.value);

  if (!length || !width || !height || weight === '' || isNaN(weight)) {
    showToast('请完整填写箱规和重量');
    return;
  }

  try {
    if (region === 'us') {
      const zip = zipInput.value.trim();
      if (!zip) {
        showToast('请输入美国邮编');
        return;
      }
      const result = await api.calculateUs({ zip, length, width, height, weight });
      renderResult(result, true);
    } else {
      const countryId = countrySelect.value;
      const result = await api.calculateEu({ countryId, length, width, height, weight });
      renderResult(result, false);
    }
  } catch (err) {
    showToast(err.message || '计算失败');
  }
});

loadData();
