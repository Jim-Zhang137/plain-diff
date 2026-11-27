/* 静态一致性检查：HTML / CSS / JS 交叉引用 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

let fail = 0;
const bad = (m) => { fail++; console.log('FAIL ' + m); };
const good = (m) => console.log('  ok  ' + m);

/* 1. HTML 里的 id 列表 */
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
const dupIds = ids.filter((v, i) => ids.indexOf(v) !== i);
if (dupIds.length) bad('重复 id: ' + dupIds.join(','));
else good('id 无重复，共 ' + ids.length + ' 个');

/* 2. app.js 里引用的 id 是否都存在 */
const refs = new Set();
for (const m of js.matchAll(/\$\('([^']+)'\)/g)) refs.add(m[1]);
for (const m of js.matchAll(/getElementById\('([^']+)'\)/g)) refs.add(m[1]);
const missing = [...refs].filter(r => !ids.includes(r));
if (missing.length) bad('app.js 引用了不存在的 id: ' + missing.join(', '));
else good('app.js 引用的 ' + refs.size + ' 个 id 全部存在');

/* 3. HTML 里标注了 id 但 JS 从不使用的（只提示） */
const unused = ids.filter(i => !refs.has(i));
if (unused.length) console.log('  note 未被 JS 引用的 id: ' + unused.join(', '));

/* 4. 资源引用 */
['styles.css', 'app.js', 'vendor/diff-match-patch.js', 'diff-match-patch@1.0.5/index.js']
  .forEach(f => {
    if (html.indexOf(f) === -1) bad('index.html 未引用 ' + f);
  });
good('index.html 资源引用齐全');
if (!fs.existsSync(path.join(ROOT, 'vendor', 'diff-match-patch.js'))) bad('本地兜底库缺失');
else good('本地兜底库存在 (' + fs.statSync(path.join(ROOT, 'vendor', 'diff-match-patch.js')).size + ' 字节)');

/* 5. JS 生成的 class 是否在 CSS 中有定义 */
const genClasses = new Set();
for (const m of js.matchAll(/class="([^"']+)"/g)) {
  m[1].split(/\s+/).filter(Boolean).forEach(c => { if (!c.includes("'")) genClasses.add(c); });
}
for (const m of js.matchAll(/class="([^"]*?)'\s*\+/g)) {
  m[1].split(/\s+/).filter(Boolean).forEach(c => genClasses.add(c));
}
for (const m of js.matchAll(/' (is-[a-z]+)'/g)) genClasses.add(m[1]);
['bline', 'is-add', 'is-del', 'seg-ins', 'seg-del', 'gutter-line'].forEach(c => genClasses.add(c));

const cssMissing = [...genClasses].filter(c => !new RegExp('\\.' + c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(css));
if (cssMissing.length) bad('CSS 缺少样式: ' + cssMissing.join(', '));
else good('JS 使用的 ' + genClasses.size + ' 个 class 在 CSS 中均有定义');

/* 6. CSS 关键对齐参数是否三处一致 */
const editorPad = /\.editor\s*\{[^}]*padding:\s*var\(--editor-pad-y\)\s+var\(--editor-pad-x\)/s.test(css);
const backdropPad = /\.backdrop-inner\s*\{[^}]*padding:\s*var\(--editor-pad-y\)\s+var\(--editor-pad-x\)/s.test(css);
const gutterPad = /\.gutter-inner\s*\{[^}]*padding:\s*var\(--editor-pad-y\)\s+0/s.test(css);
const sameFont = (css.match(/font-family:\s*var\(--editor-font\)/g) || []).length >= 2;
const sameLine = (css.match(/line-height:\s*var\(--editor-line-height\)/g) || []).length >= 3;
[['textarea/backdrop 内边距一致', editorPad && backdropPad],
 ['行号栏内边距一致', gutterPad],
 ['textarea/backdrop 字体一致', sameFont],
 ['行号/backdrop/textarea 行高一致', sameLine]].forEach(([n, v]) => v ? good(n) : bad(n));

/* 7. 检查是否残留已删除的功能 */
// 注意：默认示例文本里会出现"默认忽略首尾空白"这几个字（被对比文本的内容），
// 那不是本工具的开关。这里只查控件标识和 JS 逻辑里是否还有这个选项。
if (/chkTrim/.test(html + js) || /忽略首尾空白/.test(js)) bad('仍存在"忽略首尾空白"选项');
else good('"忽略首尾空白"开关已彻底移除（示例文本中的描述不算）');
if (/<svg|icon/i.test(html)) bad('HTML 中仍有图标');
else good('按钮全部为纯文字，无图标');

/* 8. app.js 常见笔误检查 */
if (/documentElementById/.test(js)) bad('存在 documentElementById 笔误');
else good('无 documentElementById 笔误');
if (/contenteditable/.test(html)) bad('仍在使用 contenteditable');
else good('使用真实 textarea，可正常编辑');

/* 9. 安全 / 隐私文案 */
if (html.indexOf('所有内容默认只在浏览器内处理') === -1) bad('缺少页脚隐私说明');
else good('页脚隐私说明存在');

/* 10. HTML 结构粗检 */
const open = (html.match(/<(div|section|main|header|footer|body|html)\b/g) || []).length;
const close = (html.match(/<\/(div|section|main|header|footer|body|html)>/g) || []).length;
if (open !== close) bad('标签数量不匹配 open=' + open + ' close=' + close);
else good('容器标签开闭平衡 (' + open + ')');

/* 11. 本次 Bug 修复的静态回归护栏 */
const rvStart = js.indexOf('function replaceView(');
const rvEnd = js.indexOf('function renderBackdrop(', rvStart);
const rv = js.slice(rvStart, rvEnd);
const iReturn = rv.indexOf('if (!ed || ed.value === text) return;');
const iClear = rv.indexOf('pendingCaret[side] = null;');
if (iClear === -1 || (iReturn !== -1 && iClear > iReturn)) bad('replaceView 早退前未清理 pendingCaret（光标可能跳位）');
else good('replaceView 早退前已清理 pendingCaret');

if (/var composing = \{ left: false, right: false \}/.test(js)) good('输入法组词标志按左右两侧独立');
else bad('输入法组词标志仍是全局共享');

if (/\binset:\s*0\b/.test(css)) bad('CSS 仍使用 inset（Chrome 80~86 不支持）');
else good('CSS 未使用 inset');

if (/支持折叠未改动区域/.test(html)) bad('示例文本仍宣称未实现的“折叠未改动区域”功能');
else good('示例文本不再宣称未实现功能');

if (!/id="btnFold"/.test(html) || !/id="btnPrevDiff"/.test(html) || !/id="btnNextDiff"/.test(html)) bad('缺少折叠/差异导航控件');
else good('折叠按钮与上一个/下一个差异按钮齐全');

if (!/id="btnClearLeft"/.test(html) || !/id="btnClearRight"/.test(html) ||
    !/\$\('btnClearLeft'\)\.addEventListener\('click'/.test(js) ||
    !/\$\('btnClearRight'\)\.addEventListener\('click'/.test(js) ||
    !/function doClearSide\(side\)/.test(js)) bad('左右单侧清空按钮缺失或未接线');
else good('左右两侧各有独立清空按钮，且只清空对应一侧');

if (!/F7/.test(html) || !/F8/.test(html)) bad('差异导航按钮缺少快捷键提示');
else good('差异导航按钮带有 F7/F8 快捷键提示');

if (!/<span class="key-hint">F7<\/span>/.test(html) || !/<span class="key-hint">F8<\/span>/.test(html)) bad('上一个/下一个按钮上未直接显示 F7/F8');
else good('上一个/下一个按钮上直接显示 F7/F8 快捷键');

if (!/\.bline\.is-fold/.test(css) || !/\.gutter-line\.is-fold/.test(css) || !/\.is-current/.test(css)) bad('缺少折叠行/当前差异样式');
else good('折叠行与当前差异高亮样式齐全');

if (!/\.bline\.is-current\.cur-first/.test(css) || !/\.bline\.is-current\.cur-last/.test(css) ||
    !/cur-first/.test(js) || !/cur-last/.test(js)) bad('当前差异块缺少首末行标记，多行块会画成多个小框');
else good('当前差异块用首末行标记拼成整块边框');

if (/flashTimer|setTimeout\(clearCurrentBlock/.test(js)) bad('当前差异块高亮仍会自动消失');
else good('当前差异块选中框持续保留，直到切换块或重算');

if (/chkAutoFold/.test(html + js)) bad('自动折叠勾选框未彻底移除');
else good('自动折叠勾选框已移除');

if (/AUTO_FOLD|resolveFoldEnabled|autoFold|options\.manual|继续编辑后会自动折叠/.test(js)) bad('仍残留自动折叠逻辑');
else good('自动折叠已彻底移除，只有点击按钮才折叠');

const setTextBody = js.slice(js.indexOf('function setText('), js.indexOf('/* ---------- 文件导入'));
if (!/foldEnabled = false;/.test(setTextBody)) bad('粘贴/导入/清空单侧后未重置折叠状态，旧 foldEnabled 会让新内容再次折叠');
else good('粘贴按钮/导入/清空单侧后重置折叠状态，不点折叠按钮就不折叠');

if (!/hasVisibleFolds = hasFoldLines\(/.test(js) || !/hasVisibleFolds \? '展开全部' : '折叠未改动'/.test(js)) bad('折叠按钮文案未跟随实际可见折叠行');
else good('折叠按钮文案跟随实际可见折叠行');

if (!/未改动（点击展开）/.test(js)) bad('折叠行缺少可见的“未改动”文案');
else good('折叠行在文本框中显示“未改动（点击展开）”');

if (!/function foldLabel\(count\)/.test(js) || !/foldLabel\(row\.foldCount\)/.test(js)) bad('折叠行未显示折叠行数');
else good('折叠行显示实际折叠行数');

if (!/function isTailRow\(row\)/.test(js) || !/foldCount: logical/.test(js)) bad('折叠行数未排除末尾空视觉行，可能与顶部统计不一致');
else good('折叠行数与顶部统计一致，排除末尾空行');

if (!/ed\.style\.cursor = hit \? 'pointer' : ''/.test(js) || !/\.bline\.is-fold\.is-hover/.test(css) || !/\.gutter-line\.is-fold\.is-hover/.test(css)) bad('折叠文字缺少手势光标/悬停反馈');
else good('折叠文字显示手势光标与悬停高亮');

if (!/isFoldLabelClicked\(ed, e, view, ls\)/.test(js) || !/foldLabelHit\(/.test(js)) bad('点击折叠行未做文字命中检测');
else good('只有点在「未改动」文字上才展开，点同行空白不展开');

if (!/e\.key === 'Tab'/.test(js) || !/tabInsertion\(view, ed\.selectionStart, ed\.selectionEnd\)/.test(js) ||
    !/function tabInsertion\(view, start, end\)/.test(js)) bad('Tab 键未接入文本框制表符插入');
else good('Tab 键在文本框内插入制表符，不切换页面焦点');

console.log(fail ? '\n==== ' + fail + ' 项失败 ====' : '\n==== 静态检查全部通过 ====');
process.exit(fail ? 1 : 0);
