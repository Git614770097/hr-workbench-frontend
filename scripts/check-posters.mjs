// 用 chrome --dump-dom 校验海报渲染：内容是否溢出 1080x1080、引用的截图是否加载成功
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const dir = "D:\\My\\hr-talent-pool\\posters";

const probe = `
<script>
window.addEventListener('load', function(){
  var p = document.getElementById('poster');
  var img = document.querySelector('.frame img');
  var bar = document.querySelector('.pricebar, .price');
  var barBottom = bar ? Math.round(bar.getBoundingClientRect().bottom) : -1;
  var res = {
    posterW: p.offsetWidth, posterH: p.offsetHeight,
    barBottom: barBottom,
    bottomClipped: barBottom > p.offsetHeight + 1,
    wrapScrollH: document.querySelector('.wrap').scrollHeight,
    imgLoaded: img ? (img.naturalWidth > 0) : 'no-img'
  };
  document.body.setAttribute('data-check', JSON.stringify(res));
});
</script>
`;

const files = process.argv.slice(2).length ? process.argv.slice(2)
  : ["xianyu1", "xianyu2", "xianyu3", "xianyu4"];
for (const f of files) {
  const html = readFileSync(`${dir}\\${f}.html`, "utf8");
  const tmp = `${dir}\\_check_${f}.html`;
  writeFileSync(tmp, html.replace("</body>", probe + "</body>"), "utf8");
  try {
    const out = execFileSync(CHROME, [
      "--headless=new", "--disable-gpu", "--virtual-time-budget=3000",
      "--window-size=1080,1080", "--dump-dom",
      `file:///D:/My/hr-talent-pool/posters/_check_${f}.html`,
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const m = out.match(/data-check="([^"]*)"/);
    const r = m ? JSON.parse(m[1].replace(/&quot;/g, '"')) : null;
    console.log(f, r ? JSON.stringify(r) : "NO-RESULT");
  } catch (e) {
    console.log(f, "ERR", String(e).slice(0, 200));
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}
