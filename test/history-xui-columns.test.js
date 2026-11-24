import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { Miniflare } from 'miniflare';
import { createHistoryTableSql, HISTORY_INSERT_COLUMNS, HISTORY_TABLE_COLUMNS } from '../src/utils/historyFields.js';
import { saveMetricsHistory } from '../src/database/schema.js';

const XUI_COLUMNS = [
  'hostname', 'panel_version', 'xray_version', 'xray_state',
  'online_clients', 'online_client_emails',
  'xui_inbounds_disabled', 'xui_inbounds_depleted',
  'xui_clients_disabled', 'xui_clients_depleted'
];

const miniflare = new Miniflare({
  modules: true,
  script: 'export default { fetch() { return new Response("OK"); } }',
  d1Databases: { DB: 'history-xui-columns-test' }
});
const db = await miniflare.getD1Database('DB');

await db.prepare(createHistoryTableSql('metrics_history')).run();

after(async () => { await miniflare.dispose(); });

test('metrics_history 建表含 10 个 x-ui 列，saveMetricsHistory 能写入并读回', async () => {
  const cols = await db.prepare(`PRAGMA table_info(metrics_history)`).all();
  const names = cols.results.map(c => c.name);
  for (const col of XUI_COLUMNS) {
    assert.ok(names.includes(col), `missing column ${col}`);
  }
  assert.equal(HISTORY_TABLE_COLUMNS.length, 63);
  assert.equal(HISTORY_INSERT_COLUMNS.length, 63);

  const metrics = {
    cpu: 0.5,
    load_avg: '0.01 0.03 0.07',
    net_in_speed: 0,
    net_out_speed: 0,
    net_rx: 100,
    net_tx: 50,
    processes: 10,
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
    ip_v4: '198.200.57.37',
    ip_v6: '0',
    boot_time: '1795483014',
    net_rx_monthly: 0,
    net_tx_monthly: 0,
    hostname: 'DF6IBWPNQIDGEX',
    panel_version: '3.11.0',
    xray_version: '26.10.21',
    xray_state: 'Running',
    online_clients: '1',
    online_client_emails: 'xhttp@x-ui',
    xui_inbounds_disabled: '0',
    xui_inbounds_depleted: '0',
    xui_clients_disabled: '0',
    xui_clients_depleted: '0'
  };
  await saveMetricsHistory(db, 'server-1', 1, metrics, '', Date.now(), '1.1.3-jegan.1');

  const row = await db.prepare(
    `SELECT hostname, panel_version, xray_version, xray_state, online_clients, online_client_emails, xui_inbounds_disabled, xui_inbounds_depleted, xui_clients_disabled, xui_clients_depleted FROM metrics_history WHERE server_id = ?`
  ).bind('server-1').first();
  assert.equal(row.hostname, 'DF6IBWPNQIDGEX');
  assert.equal(row.panel_version, '3.11.0');
  assert.equal(row.xray_version, '26.10.21');
  assert.equal(row.xray_state, 'Running');
  assert.equal(row.online_clients, 1);
  assert.equal(row.online_client_emails, 'xhttp@x-ui');
  assert.equal(row.xui_inbounds_disabled, 0);
  assert.equal(row.xui_inbounds_depleted, 0);
  assert.equal(row.xui_clients_disabled, 0);
  assert.equal(row.xui_clients_depleted, 0);
});
