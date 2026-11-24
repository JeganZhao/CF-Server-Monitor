import assert from 'node:assert/strict';
import test, { beforeEach, afterEach } from 'node:test';
import worker from '../src/index.js';
import { checkDailyReport, isDailyReportTimeDue, buildDailyReportMessage } from '../src/services/notification.js';
import { clearAllCaches } from '../src/utils/cache.js';
import { DEFAULT_NOTIFICATION_TEMPLATE, SITE_FIELDS } from '../src/utils/settings.js';
import { GB } from '../src/utils/traffic.js';

globalThis.WebSocketRequestResponsePair = class {};

// 2026-11-24 08:00 Asia/Shanghai == 2026-11-24 00:00 UTC
const REPORT_TIME = Date.UTC(2026, 10, 24, 0, 0, 5);
const MINUTE = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function makeSettings(overrides = {}) {
  return {
    ...Object.fromEntries(SITE_FIELDS.map(field => [field, ''])),
    tg_notify: '5',
    tg_bot_token: 'test-bot-token',
    tg_chat_id: '926502431',
    notification_timezone: 'Asia/Shanghai',
    notification_language: 'zh',
    notification_template: DEFAULT_NOTIFICATION_TEMPLATE,
    expire_notification_time: '12',
    jwt_secret: 'x'.repeat(32),
    ...overrides
  };
}

const SERVER = {
  id: '5972a03e-8d77-4ade-97fd-4f80edb54552',
  name: 'RAKsmart-hui-pc',
  history_partition_id: 1,
  timestamp: 0
};

function makeMetricsRow(now, overrides = {}) {
  return {
    id: 10261124011654,
    server_id: SERVER.id,
    timestamp: now - 30_000,
    agent_version: '1.1.3-jegan.1',
    cpu: 0.5,
    load_avg: '0.01 0.03 0.07',
    net_in_speed: 0,
    net_out_speed: 0,
    net_rx: 17.79 * GB,
    net_tx: 5.00 * GB,
    processes: 100,
    tcp_conn: 84,
    udp_conn: 4,
    ram_total: 1961,
    ram_used: 831.56,
    swap_total: 0,
    swap_used: 0,
    disk_total: 51,
    disk_used: 5.2,
    cpu_cores: 2,
    cpu_info: '',
    gpu_info: '',
    arch: 'x86_64',
    os: 'Ubuntu 24.04',
    kernel_version: '',
    region: '',
    ip_v4: '198.200.57.37',
    ip_v6: '0',
    boot_time: String(Math.floor((now - 12 * DAY_MS) / 1000)),
    net_rx_monthly: 0,
    net_tx_monthly: 0,
    hostname: 'DF6IBWPNQIDGEX',
    panel_version: '3.11.0',
    xray_version: '26.10.21',
    xray_state: 'Running',
    online_clients: 1,
    online_client_emails: 'xhttp@x-ui',
    xui_inbounds_disabled: 0,
    xui_inbounds_depleted: 0,
    xui_clients_disabled: 0,
    xui_clients_depleted: 0,
    ...overrides
  };
}

function makeDb(settings, { servers = [SERVER], metricsRow = null } = {}) {
  const state = { sentMarker: null, writes: [] };
  const db = {
    state, settings, servers, metricsRow,
    prepare(sql) {
      return {
        args: [],
        bind(...args) { this.args = args; return this; },
        async first() {
          if (sql.includes("key = 'site_options'")) {
            return { value: JSON.stringify(db.settings) };
          }
          if (sql.includes('FROM metrics_history')) {
            return db.metricsRow ? { ...db.metricsRow } : null;
          }
          if (sql.includes('FROM settings WHERE key = ?')) {
            return db.state.sentMarker === null ? null : { value: db.state.sentMarker };
          }
          throw new Error('unexpected first() SQL: ' + sql);
        },
        async all() {
          if (sql.includes('FROM servers')) {
            return { results: db.servers };
          }
          if (sql === 'SELECT * FROM settings') {
            return { results: [] };
          }
          throw new Error('unexpected all() SQL: ' + sql);
        },
        async run() {
          if (sql.includes('INSERT OR REPLACE INTO settings')) {
            db.state.sentMarker = this.args[1];
            db.state.writes.push([...this.args]);
            return { success: true, meta: { changes: 1 } };
          }
          throw new Error('unexpected run() SQL: ' + sql);
        }
      };
    }
  };
  return db;
}

let fetchCalls;
const realFetch = globalThis.fetch;

beforeEach(() => {
  clearAllCaches();
  fetchCalls = [];
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('08:00 Asia/Shanghai 到点，09:00/07:00 不到点', () => {
  const s = makeSettings();
  assert.equal(isDailyReportTimeDue(s, Date.UTC(2026, 10, 24, 0, 0)), true);
  assert.equal(isDailyReportTimeDue(s, Date.UTC(2026, 10, 24, 1, 0)), false);
  assert.equal(isDailyReportTimeDue(s, Date.UTC(2026, 10, 23, 23, 0)), false);
  assert.equal(isDailyReportTimeDue({ ...s, notification_timezone: 'UTC' }, Date.UTC(2026, 10, 24, 8, 0)), true);
});

test('日报正文按面板格式拼，数字与锚点一致', () => {
  const s = makeSettings();
  const msg = buildDailyReportMessage(SERVER, makeMetricsRow(REPORT_TIME), s, REPORT_TIME);
  assert.equal(msg, [
    '主机：DF6IBWPNQIDGEX',
    'X-UI 版本：3.11.0',
    'Xray 版本：26.10.21',
    'IPv4：198.200.57.37',
    '服务器运行：12天',
    '服务器负载：0.01，0.03，0.07',
    '内存：831.56MB/1.92GB',
    '在线客户：1',
    'TCP：84',
    'UDP：4',
    '流量：22.79GB（↑5.00GB，↓17.79GB）',
    '状态：running',
    '耗尽的入站数量（禁用 0、即将耗尽 0）',
    '耗尽的客户端数量（禁用 0、即将耗尽 0）'
  ].join('\n'));
});

test('08:00 定时触发发一份日报到 926502431，写去重标记', async () => {
  const settings = makeSettings();
  const db = makeDb(settings, { metricsRow: makeMetricsRow(REPORT_TIME) });
  const sent = await checkDailyReport(db, { scheduled: true, now: REPORT_TIME, siteSettings: settings });
  assert.equal(sent, true);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'https://api.telegram.org/bottest-bot-token/sendMessage');
  assert.equal(fetchCalls[0].body.chat_id, '926502431');
  assert.match(fetchCalls[0].body.text, /定时报告/);
  assert.match(fetchCalls[0].body.text, /主机：DF6IBWPNQIDGEX/);
  assert.match(fetchCalls[0].body.text, /在线客户：1/);
  assert.match(fetchCalls[0].body.text, /流量：22.79GB/);
  assert.equal(db.state.sentMarker, String(Math.floor(Date.UTC(2026, 10, 24) / DAY_MS)));
});

test('同一天第二次不重发', async () => {
  const settings = makeSettings();
  const db = makeDb(settings, { metricsRow: makeMetricsRow(REPORT_TIME) });
  assert.equal(await checkDailyReport(db, { scheduled: true, now: REPORT_TIME, siteSettings: settings }), true);
  assert.equal(fetchCalls.length, 1);
  assert.equal(await checkDailyReport(db, { scheduled: true, now: REPORT_TIME + 1000, siteSettings: settings }), false);
  assert.equal(fetchCalls.length, 1);
});

test('09:00 定时触发不发', async () => {
  const settings = makeSettings();
  const db = makeDb(settings, { metricsRow: makeMetricsRow(REPORT_TIME) });
  assert.equal(await checkDailyReport(db, { scheduled: true, now: Date.UTC(2026, 10, 24, 1, 0), siteSettings: settings }), false);
  assert.equal(fetchCalls.length, 0);
});

test('force 手动触发不看时间', async () => {
  const settings = makeSettings();
  const db = makeDb(settings, { metricsRow: makeMetricsRow(REPORT_TIME) });
  assert.equal(await checkDailyReport(db, { force: true, now: Date.UTC(2026, 10, 24, 1, 0), siteSettings: settings }), true);
  assert.equal(fetchCalls.length, 1);
});

test('没有指标行不发、不写标记', async () => {
  const settings = makeSettings();
  const db = makeDb(settings, { metricsRow: null });
  assert.equal(await checkDailyReport(db, { scheduled: true, now: REPORT_TIME, siteSettings: settings }), false);
  assert.equal(fetchCalls.length, 0);
  assert.equal(db.state.sentMarker, null);
});

test('没有通知目标不发', async () => {
  const settings = makeSettings({ tg_bot_token: '' });
  const db = makeDb(settings, { metricsRow: makeMetricsRow(REPORT_TIME) });
  assert.equal(await checkDailyReport(db, { scheduled: true, now: REPORT_TIME, siteSettings: settings }), false);
  assert.equal(fetchCalls.length, 0);
});

test('指标超过 10 分钟加过期提示行', () => {
  const s = makeSettings();
  const row = makeMetricsRow(REPORT_TIME, { timestamp: REPORT_TIME - 30 * MINUTE });
  const msg = buildDailyReportMessage(SERVER, row, s, REPORT_TIME);
  assert.match(msg, /数据已过期/);
  assert.match(msg, /最后上报: 2026\/11\/24 07:30:05/);
});

test('没有 x-ui 字段的节点只发系统字段', () => {
  const s = makeSettings();
  const row = makeMetricsRow(REPORT_TIME, { hostname: '', panel_version: '', xray_version: '', xray_state: '' });
  const msg = buildDailyReportMessage(SERVER, row, s, REPORT_TIME);
  assert.doesNotMatch(msg, /在线客户/);
  assert.doesNotMatch(msg, /耗尽/);
  assert.doesNotMatch(msg, /X-UI 版本/);
  assert.match(msg, /服务器负载/);
  assert.match(msg, /流量：22.79GB/);
});

test('每小时 cron 在 08:00 走到日报分支', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  t.mock.timers.setTime(REPORT_TIME);
  try {
    const settings = makeSettings();
    const db = makeDb(settings, { metricsRow: makeMetricsRow(REPORT_TIME) });
    await worker.scheduled({ cron: '0 * * * *' }, { DB: db }, {});
    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0].body.text, /主机：DF6IBWPNQIDGEX/);
    assert.match(fetchCalls[0].body.text, /定时报告/);
  } finally {
    t.mock.timers.reset();
  }
});
