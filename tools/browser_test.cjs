/* Real browser checks of the shipped UI; API data is explicitly synthetic. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const status = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/status.json')));
const settings = {wifi_ssid:'Rehab-Demo',has_password:true,socket_server:'192.0.2.10',heart_rate_address:'AA:BB:CC:DD:EE:01'};
let revision=1, conflict=false, posts=[];
const controlPosts = [];
let releaseStart, rejectStop = false, statusAvailable = true;
const waitForStart = new Promise(resolve => { releaseStart = resolve; });
const server = http.createServer(async (req,res)=>{
  const body=[]; for await (const part of req) body.push(part);
  const json = (value,code=200)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  if(req.url==='/api/status') return statusAvailable ? json(status) : json({error:'連線中斷'}, 503);
  if (req.url === '/api/control/start' || req.url === '/api/control/stop') {
    controlPosts.push({ path: req.url, method: req.method, type: req.headers['content-type'], body: Buffer.concat(body).toString() });
    if (req.url === '/api/control/start') await waitForStart;
    else if (rejectStop) return json({ error: '停止指令測試錯誤' }, 409);
    return json({ ok: true }, 202);
  }
  if(req.url==='/api/config') {
    if(req.method==='GET') return json({revision,pending:false,settings,active:settings});
    const payload=JSON.parse(Buffer.concat(body)); posts.push(payload);
    if(conflict || payload.revision!==revision) return json({error:'設定版本衝突'},409);
    Object.assign(settings,payload); delete settings.wifi_password; return json({ok:true,pending:true,revision:++revision});
  }
  if(req.url==='/api/scan/wifi') return json({state:'done',results:[{ssid:'<script>demo</script>',rssi:-50,secure:true,channel:1}],error:''});
  if(req.url==='/api/scan/ble') return json({state:'done',results:[{name:'Demo Sensor',address:'AA:BB:CC:DD:EE:02',address_type:'random',rssi:-55,heart_rate:true}],error:''});
  const assets={'/':['index.html','text/html'],'/style.css':['style.css','text/css'],'/app.js':['app.js','application/javascript']};
  if(!assets[req.url]) {res.writeHead(404); return res.end();}
  const [file,type]=assets[req.url]; res.writeHead(200,{'Content-Type':type+'; charset=utf-8'});res.end(fs.readFileSync(path.join(root,'web',file)));
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
  const errors=[];
  try {
    const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1});
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(()=>document.getElementById('metricBpm').textContent==='80');
    assert.equal(await page.locator('#metricRpm').innerText(),'60');
    assert.equal(await page.locator('#metricLevel').innerText(),'8');
    assert.equal(await page.locator('#apEntry').getAttribute('href'),'http://192.168.4.1/');
    assert.equal(await page.locator('#lanEntry').getAttribute('href'),'http://192.0.2.20/');
    assert.equal(await page.locator('#lanEntry').getAttribute('target'),'_blank');
    for(const width of [360,390,768,1440]) {
      await page.setViewportSize({width,height:900});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`overflow at ${width}px`);
    }
    await page.setViewportSize({width:390,height:844});
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({path:path.join(root,'docs/images/dashboard-mobile.png'),fullPage:true});
    const startMachine = page.getByRole('button', { name: 'Start 啟動' });
    const stopMachine = page.getByRole('button', { name: 'Stop 停止' });
    await startMachine.click();
    assert.equal(await startMachine.isDisabled(), true);
    assert.equal(await stopMachine.isDisabled(), true);
    releaseStart();
    await page.waitForFunction(() => document.getElementById('controlMessage').textContent === 'ESP32 已接受 Start 指令。');
    statusAvailable = false;
    await page.waitForFunction(() => document.getElementById('startMachine').disabled);
    await stopMachine.click();
    await page.waitForFunction(() => document.getElementById('controlMessage').textContent === 'ESP32 已接受 Stop 指令。');
    assert.deepEqual(controlPosts, ['start', 'stop'].map(action => ({
      path: `/api/control/${action}`, method: 'POST', type: 'application/json', body: '{}'
    })));
    rejectStop = true;
    await stopMachine.click();
    await page.waitForFunction(() => document.getElementById('controlMessage').textContent.includes('停止指令測試錯誤'));
    statusAvailable = true;
    await page.locator('#wifiSsid').fill('Edited-Demo');
    await page.waitForTimeout(1200);
    assert.equal(await page.locator('#wifiSsid').inputValue(),'Edited-Demo');
    status.wifi.state='retrying';
    await page.waitForFunction(()=>document.getElementById('lanEntry').textContent==='—');
    assert.equal(await page.locator('#lanEntry').getAttribute('href'),null);
    assert.equal(await page.locator('#apEntry').getAttribute('href'),'http://192.168.4.1/');
    status.wifi.state='connected'; status.wifi.ip='';
    await page.waitForTimeout(1100);
    assert.equal(await page.locator('#lanEntry').getAttribute('href'),null);
    status.wifi.ip='192.0.2.21';
    await page.waitForFunction(()=>document.getElementById('lanEntry').getAttribute('href')==='http://192.0.2.21/');
    assert.equal(await page.locator('#wifiSsid').inputValue(),'Edited-Demo');
    await page.locator('#saveConfig').click();
    await page.waitForFunction(()=>document.getElementById('configMessage').textContent.includes('保存')||document.getElementById('configMessage').textContent.includes('儲存成功'));
    assert.equal(Object.hasOwn(posts.at(-1),'wifi_password'),false);
    conflict=true;
    await page.locator('#wifiSsid').fill('Conflict-Edit'); await page.locator('#saveConfig').click();
    await page.waitForFunction(()=>document.getElementById('configMessage').textContent.includes('其他頁面修改'));
    assert.equal(await page.locator('#wifiSsid').inputValue(),'Conflict-Edit');
    await page.locator('#scanWifi').click();
    await page.waitForFunction(()=>document.getElementById('wifiResults').textContent.includes('<script>demo</script>'));
    assert.equal(await page.locator('#wifiResults script').count(),0);
    await page.locator('#scanBle').click();
    await page.waitForFunction(()=>document.getElementById('bleResults').textContent.includes('Demo Sensor'));
    status.machine.age28_ms=7000; status.machine.age3f_ms=8000;
    await page.waitForFunction(()=>document.getElementById('rpmBadge').textContent.includes('過期'));
    await page.locator('#advancedDetails').evaluate(el=>el.open=true);
    await page.setViewportSize({width:1440,height:1000});
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({path:path.join(root,'docs/images/diagnostics-desktop.png'),fullPage:true});
    assert.deepEqual(errors,[]); console.log('Browser QA passed: Start/Stop requests, responsive layouts, rendering, AP/LAN entries, IP changes, preserved edits, save, conflict, scans, XSS and stale data.');
  } finally {await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
