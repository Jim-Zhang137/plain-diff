/* PlainDiff 逻辑自测（仅开发期使用，不属于页面运行依赖） */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// --- 浏览器环境的最小桩 ---
global.window = global;
global.module = { exports: {} };
global.document = {
  readyState: 'loading',              // 让 app.js 不真正 init()，只暴露纯函数
  addEventListener() {},
  getElementById() { return null; }
};

// --- 载入真实的 diff-match-patch（本地副本，与 CDN 同版本） ---
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'vendor', 'diff-match-patch.js'), 'utf8'));
if (typeof diff_match_patch !== 'function') {
  throw new Error('diff-match-patch 未能加载');
}

// --- 载入被测代码 ---
require(path.join(ROOT, 'app.js'));
const T = global.window.PlainDiff;
if (!T) throw new Error('app.js 未暴露 PlainDiff');

const dmp = new diff_match_patch();

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL: ' + name + '\n  期望: ' + JSON.stringify(expected) + '\n  实际: ' + JSON.stringify(actual)); }
}
function ok(name, cond, extra) {
  if (cond) pass++;
  else { fail++; console.log('FAIL: ' + name + (extra ? '  -> ' + extra : '')); }
}

function dialect(a, b) {
  const diffs = dmp.diff_main(a, b);
  dmp.diff_cleanupSemantic(diffs);
  return diffs;
}
function rebuild(lines) {
  return lines.map(l => l.segs.map(s => s.text).join('')).join('\n');
}
function marks(lines, key) {
  return lines.map(l => l[key]);
}

/* ---------- 1. countLines ---------- */
eq('countLines ""', T.countLines(''), 0);
eq('countLines "a"', T.countLines('a'), 1);
eq('countLines "a\\n"', T.countLines('a\n'), 1);
eq('countLines "a\\nb"', T.countLines('a\nb'), 2);
eq('countLines "\\n"', T.countLines('\n'), 1);
eq('countLines "a\\n\\n"', T.countLines('a\n\n'), 2);

/* ---------- 2. 字符级高亮：单行局部修改 ---------- */
{
  const a = 'hello world';
  const b = 'hello brave world';
  const diffs = dialect(a, b);
  const L = T.buildSide(diffs, 'left');
  const R = T.buildSide(diffs, 'right');
  eq('单行修改/左侧行数', L.length, 1);
  eq('单行修改/右侧行数', R.length, 1);
  eq('单行修改/左侧无新增标', marks(L, 'hasIns'), [false]);
  eq('单行修改/左侧无删除标', marks(L, 'hasDel'), [false]);
  eq('单行修改/右侧有新增标', marks(R, 'hasIns'), [true]);
  ok('单行修改/左侧文本还原', rebuild(L) === a, rebuild(L));
  ok('单行修改/右侧文本还原', rebuild(R) === b, rebuild(R));
  const insText = R[0].segs.filter(s => s.cls === 'ins').map(s => s.text).join('');
  eq('单行修改/新增片段', insText, 'brave ');
}

/* ---------- 3. 删除内容只在左侧标记 ---------- */
{
  const a = 'keep DELETE keep';
  const b = 'keep keep';
  const diffs = dialect(a, b);
  const L = T.buildSide(diffs, 'left');
  const R = T.buildSide(diffs, 'right');
  ok('删除/左侧有删除标', L[0].hasDel === true);
  ok('删除/右侧无新增标', R[0].hasIns === false);
  eq('删除/左侧删除片段', L[0].segs.filter(s => s.cls === 'del').map(s => s.text).join(''), 'DELETE ');
  eq('删除/统计', T.computeStats(dmp, a, b), { add: 1, del: 1, eq: 0 });
}

/* ---------- 4. 多行新增/删除 统计 ---------- */
{
  const a = 'a\nb\nc\nd\ne';
  const b = 'a\nB\nc\ne\nf\nf2';
  const s = T.computeStats(dmp, a, b);
  eq('多行统计', s, { add: 3, del: 2, eq: 3 });
  eq('统计守恒(左)', s.eq + s.del, T.countLines(a));
  eq('统计守恒(右)', s.eq + s.add, T.countLines(b));
}

/* ---------- 5. 纯删除 / 纯新增行 ---------- */
{
  const s = T.computeStats(dmp, 'a\nb\nc', 'a\nc');
  eq('纯删除行统计', s, { add: 0, del: 1, eq: 2 });
  const s2 = T.computeStats(dmp, 'a\nc', 'a\nb\nc');
  eq('纯新增行统计', s2, { add: 1, del: 0, eq: 2 });
}

/* ---------- 6. 空文本 ---------- */
{
  const s = T.computeStats(dmp, '', '');
  eq('空文本统计', s, { add: 0, del: 0, eq: 0 });
  const s2 = T.computeStats(dmp, '', 'x\ny');
  eq('空->有内容统计', s2, { add: 2, del: 0, eq: 0 });
  const L = T.buildSide(dialect('', 'x'), 'left');
  eq('空左侧行数', L.length, 1);
  ok('空左侧重建', rebuild(L) === '');
}

/* ---------- 7. 行模型重建不变式（随机压力测试） ---------- */
function randText(seed) {
  const words = ['alpha', 'beta', '', '中文内容', 'x', '  空格  ', 'tab\there', 'a b c', '{符号}<>'];
  let s = '';
  let n = 0;
  let seedv = seed;
  const rnd = () => (seedv = (seedv * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  n = Math.floor(rnd() * 14);
  for (let i = 0; i < n; i++) {
    s += words[Math.floor(rnd() * words.length)];
    if (i < n - 1) s += '\n';
  }
  return s;
}

let stressOk = true;
for (let i = 0; i < 300; i++) {
  const a = randText(i * 7 + 1);
  const b = randText(i * 13 + 5);
  const diffs = dialect(a, b);
  const L = T.buildSide(diffs, 'left');
  const R = T.buildSide(diffs, 'right');
  if (rebuild(L) !== a) { stressOk = false; console.log('左侧重建失败 seed=' + i, JSON.stringify(a)); break; }
  if (rebuild(R) !== b) { stressOk = false; console.log('右侧重建失败 seed=' + i, JSON.stringify(b)); break; }
  // 空文本的 buildSide 会返回 1 个空行，这是预期（textarea 也有 1 个可视行）
  if (a !== '' && L.length !== a.split('\n').length) { stressOk = false; console.log('左侧行数不符 seed=' + i); break; }
  if (b !== '' && R.length !== b.split('\n').length) { stressOk = false; console.log('右侧行数不符 seed=' + i); break; }
  const s = T.statsFromLineDiffs(T.lineDiffs(dmp, a, b));
  if (s.eq + s.del !== T.countLines(a)) { stressOk = false; console.log('左守恒失败 seed=' + i, s, JSON.stringify(a)); break; }
  if (s.eq + s.add !== T.countLines(b)) { stressOk = false; console.log('右守恒失败 seed=' + i, s, JSON.stringify(b)); break; }
}
ok('300 组随机文本：重建 + 行数 + 统计守恒', stressOk);

/* ---------- 8. 中文 / 换行 / emoji 字符级 ---------- */
{
  const a = '第一行：你好世界\n第二行：保持不变\n第三行：结束';
  const b = '第一行：你好，美丽世界\n第二行：保持不变\n第三行：真的结束了';
  const diffs = dialect(a, b);
  const L = T.buildSide(diffs, 'left');
  const R = T.buildSide(diffs, 'right');
  ok('中文重建左', rebuild(L) === a);
  ok('中文重建右', rebuild(R) === b);
  eq('中文行数', [L.length, R.length], [3, 3]);
  ok('中文第1行右侧有新增', R[0].hasIns === true);
  ok('中文第2行两侧都没标记', R[1].hasIns === false && L[1].hasDel === false);
  eq('中文统计', T.computeStats(dmp, a, b), { add: 2, del: 2, eq: 1 });
}

/* ---------- 9. HTML 转义（防止高亮层被注入） ---------- */
eq('esc', T.esc('<b>&"x"</b>'), '&lt;b&gt;&amp;"x"&lt;/b&gt;');

/* ---------- 10. 对比报告 ---------- */
{
  const a = 'line1\nline2\nline3';
  const b = 'line1\nLINE2\nline3\nline4';
  const rep = T.buildReport(dmp, a, b);
  ok('报告含标题', rep.indexOf('PlainDiff 文本对比报告') !== -1);
  ok('报告含新增统计', /新增 2 行/.test(rep), rep.split('\r\n')[6]);
  ok('报告含删除统计', /删除 1 行/.test(rep));
  ok('报告含删除明细前缀', rep.indexOf('- line2') !== -1);
  ok('报告含新增明细前缀', rep.indexOf('+ LINE2') !== -1);
  ok('报告含新增行 line4', rep.indexOf('+ line4') !== -1);
  ok('报告含相同行', rep.indexOf('  line1') !== -1);
  ok('报告含隐私说明', rep.indexOf('未上传任何服务器') !== -1);
}

/* ---------- 11. 完全相同的文本 → 无任何标记 ---------- */
{
  const a = 'same\ntext\nhere';
  const diffs = dialect(a, a);
  const L = T.buildSide(diffs, 'left');
  ok('相同文本无标记', L.every(l => !l.hasIns && !l.hasDel));
  eq('相同文本统计', T.computeStats(dmp, a, a), { add: 0, del: 0, eq: 3 });
}

/* ---------- 11b. 口径回归：空行计入相同，改一行 = 1 新增 + 1 删除 ---------- */
{
  const a = [
    '项目名称：小青柠文本对比工具',
    '版本：1.0.0',
    '发布说明：',
    '支持并排对比',
    '支持本地导入文本',
    '默认忽略首尾空白',
    '',
    '备注：',
    '所有内容只在浏览器内处理。'
  ].join('\n');
  const b = [
    '项目名称：小青柠文本对比工具',
    '版本：1.1.0',
    '发布说明：',
    '支持并排和行内对比',
    '支持本地导入文本和剪贴板粘贴',
    '默认忽略首尾空白',
    '支持折叠未改动区域',
    '',
    '备注：',
    '所有内容默认只在浏览器内处理。'
  ].join('\n');
  const s = T.computeStats(dmp, a, b);
  eq('发布说明文本统计', s, { add: 5, del: 4, eq: 5 });
  eq('发布说明文本守恒(左)', s.eq + s.del, T.countLines(a));
  eq('发布说明文本守恒(右)', s.eq + s.add, T.countLines(b));
  ok('发布说明文本统计可对上账', s.eq + s.del === 9 && s.eq + s.add === 10);
  ok('发布说明文本报告无"修改"字样', T.buildReport(dmp, a, b).indexOf('修改') === -1);
  const flags = T.lineLevelFlags(T.lineDiffs(dmp, a, b));
  eq('行级标记/左侧被删行', Object.keys(flags.del).map(Number), [1, 3, 4, 8]);
  eq('行级标记/右侧被插行', Object.keys(flags.ins).map(Number), [1, 3, 4, 6, 9]);
  eq('行级标记/数量与统计一致', [Object.keys(flags.del).length, Object.keys(flags.ins).length], [s.del, s.add]);
}

/* ---------- 11c. 纯插入点定位（左侧窄占位符用） ---------- */
{
  eq('纯插入点/中间插入', T.insertionPoints(dialect('支持并排对比', '支持并排和行内对比')), [{ line: 0, col: 4 }]);
  eq('纯插入点/开头插入', T.insertionPoints(dialect('abc', 'Xabc')), [{ line: 0, col: 0 }]);
  eq('纯插入点/末尾插入', T.insertionPoints(dialect('abc', 'abcX')), [{ line: 0, col: 3 }]);
  eq('纯插入点/跨行插入', T.insertionPoints(dialect('aa\nbb', 'aa\nXbb')), [{ line: 1, col: 0 }]);

  // 对称：左侧多出来的字符，在右侧对应位置也要能画深绿窄占位符
  const sym = dialect('发1布说明：', '发布说3明2：');
  eq('纯插入点/左侧多字在右侧位置', T.insertionPoints(sym, -1), [
    { line: 0, col: 1 }, { line: 0, col: 3 }
  ]);
  eq('纯插入点/默认仍取右侧插入位置', T.insertionPoints(sym), [{ line: 0, col: 5 }]);
  eq('纯插入点/跨行左侧多字', T.insertionPoints(dialect('aa\nXbb', 'aa\nbb'), -1), [{ line: 1, col: 0 }]);
}

/* ---------- 11d. 对齐视图 / 占位行 ---------- */
{
  eq('对齐/纯插入补左侧占位', T.alignRows([[0, 'A\n'], [1, 'B\n'], [0, 'C']], 2, 3), [
    { op: 'eq', leftLine: 0, rightLine: 0 },
    { op: 'ins', leftLine: -1, rightLine: 1 },
    { op: 'eq', leftLine: 1, rightLine: 2 }
  ]);
  eq('对齐/纯删除补右侧占位', T.alignRows([[0, 'A\n'], [-1, 'B\n'], [0, 'C']], 3, 2), [
    { op: 'eq', leftLine: 0, rightLine: 0 },
    { op: 'del', leftLine: 1, rightLine: -1 },
    { op: 'eq', leftLine: 2, rightLine: 1 }
  ]);
  eq('对齐/改行配对不产生占位', T.alignRows([[0, 'A\n'], [-1, 'B\n'], [1, 'X\n'], [0, 'C']], 3, 3), [
    { op: 'eq', leftLine: 0, rightLine: 0 },
    { op: 'change', leftLine: 1, rightLine: 1 },
    { op: 'eq', leftLine: 2, rightLine: 2 }
  ]);

  const view = 'abc\n' + T.PH + '\ndef';
  eq('视图转真实/去占位行', T.viewToSource(view), 'abc\ndef');
  eq('视图转真实/误粘标记', T.viewToSource('abc\n' + T.PH + 'X'), 'abc\nX');
  eq('光标映射/视图到真实', T.caretViewToSource(view, 10), 7);
  eq('光标映射/真实到视图', T.caretSourceToView(view, 7, [false, true, false]), 10);

  const one = [{ op: 'ins', leftLine: -1, rightLine: 0 }];
  const rightModel = [{ segs: [{ text: 'X', cls: 'ins' }], hasIns: true }];
  eq('视图行/左侧占位', T.buildViewLines(one, rightModel, 'left')[0].placeholder, true);
  eq('视图行/右侧符号', T.buildViewLines(one, rightModel, 'right')[0].sign, '+');
  eq('视图行/文本还原', T.viewLinesToText(T.buildViewLines(one, rightModel, 'right')), 'X');

  const delRows = [
    { op: 'del', leftLine: 0, rightLine: -1 },
    { op: 'del', leftLine: 1, rightLine: -1 },
    { op: 'del', leftLine: 2, rightLine: -1 }
  ];
  const emptyRight = T.buildViewLines(delRows, [], 'right', true);
  const emptyView = T.viewLinesToText(emptyRight);
  eq('空侧/首行是可编辑空行', {
    text: emptyRight[0].text,
    placeholder: emptyRight[0].placeholder,
    editableBlank: emptyRight[0].editableBlank
  }, { text: '', placeholder: false, editableBlank: true });
  eq('空侧/其余仍是占位行', emptyRight.slice(1).every(function (l) { return l.placeholder; }), true);
  eq('空侧/视图还原仍为空文本', T.viewToSource(emptyView), '');
  eq('空侧/光标落在首行', T.caretViewToSource(emptyView, 0), 0);
  eq('空侧/真实位置映射回首行', T.caretSourceToView(emptyView, 0, [false, true, true]), 0);
}

/* ---------- 11e. 纯插入/纯删除也要给另一侧画行级底色 ---------- */
{
  const ld = T.lineDiffs(dmp, '发布说1明：', '发布说明：');
  const flags = T.lineLevelFlags(ld);
  eq('行级标记/单字删除左右都标记', [!!flags.del[0], !!flags.ins[0]], [true, true]);

  const rows = [{ op: 'change', leftLine: 0, rightLine: 0 }];
  const noCharMark = [{ segs: [{ text: '发布说明：', cls: null }], hasDel: false, hasIns: false }];
  eq('行级底色/纯删除右侧也上色', T.buildViewLines(rows, noCharMark, 'right', false, flags)[0].hasMark, true);
  eq('行级底色/纯插入左侧也上色', T.buildViewLines(rows, noCharMark, 'left', false, flags)[0].hasMark, true);
  eq('行级底色/无标记时不上色', T.buildViewLines(rows, noCharMark, 'right', false, null)[0].hasMark, false);
}

/* ---------- 12. 大文本性能（5000 行） ---------- */
{
  const linesA = [], linesB = [];
  for (let i = 0; i < 5000; i++) {
    linesA.push('这是一个用于性能测试的较长行内容，编号 ' + i + ' ABCDEFG');
    linesB.push(i % 97 === 0 ? '这一行被修改过，编号 ' + i : '这是一个用于性能测试的较长行内容，编号 ' + i + ' ABCDEFG');
  }
  const a = linesA.join('\n');
  const b = linesB.join('\n');
  const t0 = Date.now();
  const diffs = dmp.diff_main(a, b);
  dmp.diff_cleanupSemantic(diffs);
  const L = T.buildSide(diffs, 'left');
  const R = T.buildSide(diffs, 'right');
  const s = T.computeStats(dmp, a, b);
  const ms = Date.now() - t0;
  ok('5000 行重建正确', rebuild(L) === a && rebuild(R) === b);
  ok('5000 行耗时 < 3000ms', ms < 3000, ms + 'ms');
  eq('5000 行新增数', s.add, 52);
  eq('5000 行删除数', s.del, 52);
  eq('5000 行相同数', s.eq, 4948);
  console.log('  · 5000 行对比耗时: ' + ms + 'ms，统计: ' + JSON.stringify(s));
}

/* ---------- 13. 回归：行尾 \n 不产生幽灵差异，行数与统计口径一致 ---------- */
{
  function rowsOf(a, b) {
    const ld = T.lineDiffs(dmp, a, b);
    return T.alignRows(ld, T.sourceLineCount(a), T.sourceLineCount(b));
  }
  function viewOf(a, b) {
    const ld = T.lineDiffs(dmp, a, b);
    const rows = T.alignRows(ld, T.sourceLineCount(a), T.sourceLineCount(b));
    const chars = dialect(a, b);
    const flags = T.lineLevelFlags(ld);
    const L = T.buildViewLines(rows, T.buildSide(chars, 'left'), 'left', b !== '', flags);
    const R = T.buildViewLines(rows, T.buildSide(chars, 'right'), 'right', a !== '', flags);
    return {
      rows, L, R,
      lSigns: L.map(x => x.sign),
      rSigns: R.map(x => x.sign),
      lText: T.viewLinesToText(L),
      rText: T.viewLinesToText(R)
    };
  }

  const pairs = [
    ['a\n', 'a\n'],
    ['a\nb\n', 'a\nb\n'],
    ['a\nb', 'a\nb\n'],
    ['a\nb\n', 'a\nb'],
    ['', 'x\n'],
    ['a\nb\n', 'a\nc\n'],
    ['a\nb\n\n', 'a\nb\n\n']
  ];
  pairs.forEach(function (pair) {
    const a = pair[0], b = pair[1];
    const v = viewOf(a, b);
    const tag = '行尾换行/' + JSON.stringify(a) + ' vs ' + JSON.stringify(b);
    ok(tag + ' 左侧视图可还原', T.viewToSource(v.lText) === a, JSON.stringify(v.lText));
    ok(tag + ' 右侧视图可还原', T.viewToSource(v.rText) === b, JSON.stringify(v.rText));
    if (a === b) {
      ok(tag + ' 无幽灵符号', v.lSigns.every(x => x === '') && v.rSigns.every(x => x === ''), JSON.stringify(v.lSigns) + JSON.stringify(v.rSigns));
      eq(tag + ' 统计为 0 差异', T.computeStats(dmp, a, b), { add: 0, del: 0, eq: T.countLines(a) });
      ok(tag + ' 行数与统计一致', T.countLines(a) === T.computeStats(dmp, a, b).eq);
    }
  });

  eq('行尾换行/双侧兜底行为 tail', rowsOf('a\nb\n', 'a\nb\n').slice(-1)[0].op, 'tail');
  eq('行尾换行/仅右侧多空行为 tail-right', rowsOf('a\nb', 'a\nb\n').slice(-1)[0].op, 'tail-right');
  eq('行尾换行/仅左侧多空行为 tail-left', rowsOf('a\nb\n', 'a\nb').slice(-1)[0].op, 'tail-left');

  const diffTail = viewOf('a\nb\n', 'a\nc\n');
  eq('行尾换行/真实差异行仍有符号', [diffTail.lSigns[1], diffTail.rSigns[1]], ['-', '+']);
  eq('行尾换行/末尾空行没有符号', [diffTail.lSigns[2], diffTail.rSigns[2]], ['', '']);
  ok('行尾换行/末尾空行没有底色标记', !diffTail.L[2].hasMark && !diffTail.R[2].hasMark);
}

/* ---------- 14. 回归：输入还原保留用户自带的零宽字符 ---------- */
{
  const own = T.PH + 'abc\n' + T.PH + '\ndef';
  eq('输入还原/保留真实行首零宽字符', T.viewToSourceForInput(own), T.PH + 'abc\ndef');
  eq('输入还原/仍然跳过占位行', T.viewToSourceForInput('abc\n' + T.PH + '\ndef'), 'abc\ndef');
  eq('输入还原/普通文本不受影响', T.viewToSourceForInput('a\nb\n'), 'a\nb\n');
  eq('复制还原/旧 API 行为不变', T.viewToSource(own), 'abc\ndef');
}

/* ---------- 15. 折叠未改动区域 + 差异导航 ---------- */
{
  function mkModel(lines) {
    return lines.map(function (s) {
      return { segs: [{ text: s, cls: null }], hasIns: false, hasDel: false };
    });
  }
  const leftLines = [], rightLines = [], rows = [];
  for (let i = 0; i < 12; i++) {
    leftLines.push('L' + i);
    rightLines.push(i === 6 ? 'R6' : 'L' + i);
    rows.push({ op: i === 6 ? 'change' : 'eq', leftLine: i, rightLine: i });
  }
  const leftModel = mkModel(leftLines);
  const rightModel = mkModel(rightLines);

  const plan = T.foldRows(rows, leftModel, rightModel, 3, {});
  eq('折叠/视图行数压缩为 9', plan.rows.length, 9);
  eq('折叠/差异行索引', plan.diffIndices, [4]);
  eq('折叠/前后各生成一个折叠块', plan.rows.filter(r => r.op === 'fold').map(r => r.foldCount), [3, 2]);
  eq('折叠/左侧隐藏内容完整', plan.rows[0].hidden.left, ['L0', 'L1', 'L2']);
  eq('折叠/右侧隐藏内容完整', plan.rows[0].hidden.right, ['L0', 'L1', 'L2']);
  eq('折叠/折叠块 id 稳定', plan.rows[0].foldId, 'r0');

  const expanded = T.foldRows(rows, leftModel, rightModel, 3, { r0: true });
  eq('折叠/局部展开后行数', expanded.rows.length, 11);
  eq('折叠/局部展开后差异索引', expanded.diffIndices, [6]);
  ok('折叠/局部展开后前半段不再有折叠块', expanded.rows.slice(0, 3).every(r => r.op !== 'fold'));

  const foldedView = 'A\n' + T.FOLD + '\nB';
  eq('折叠/输入还原把隐藏行插回去', T.viewToSourceForInput(foldedView, [['H1', 'H2']]), 'A\nH1\nH2\nB');
  eq('折叠/无隐藏信息时只去掉标记行', T.viewToSourceForInput(foldedView), 'A\nB');
  eq('折叠/复制路径也去掉折叠标记', T.viewToSource(foldedView), 'A\nB');

  const bStart = 2 + T.FOLD.length + 1;
  eq('折叠/光标落在折叠行映射到隐藏区开头', T.caretViewToSource(foldedView, 2, null, [['H1', 'H2']]), 2);
  eq('折叠/光标跨过折叠行映射到后续真实行', T.caretViewToSource(foldedView, bStart, null, [['H1', 'H2']]), 8);
  eq('折叠/源码位置映射回折叠行', T.caretSourceToView(foldedView, 2, null, [['H1', 'H2']]), 2);
  eq('折叠/源码位置映射回折叠后真实行', T.caretSourceToView(foldedView, 8, null, [['H1', 'H2']]), bStart);

  // 未改变时的差异索引应与折叠无关
  eq('导航/未折叠时索引即全部差异行', T.changedRowIndices(rows), [6]);

  /* 导航按"连续差异块"跳转：相邻差异行合并，整块算 1 */
  eq('导航块/空索引返回空块列表', T.groupDiffBlocks([]), []);
  eq('导航块/单个差异行算一块', T.groupDiffBlocks([6]), [{ start: 6, end: 6 }]);
  eq('导航块/相邻行合并成一块', T.groupDiffBlocks([2, 3, 4]), [{ start: 2, end: 4 }]);
  eq('导航块/隔行差异分成多块',
     T.groupDiffBlocks([2, 3, 4, 9, 10, 15]),
     [{ start: 2, end: 4 }, { start: 9, end: 10 }, { start: 15, end: 15 }]);

  // 真实行级 diff：连续两行修改应只得到 1 个导航块
  const blockA = 'a\nb\nc\nd\ne\n';
  const blockB = 'a\nB\nC\nd\ne\n';
  const blockLd = T.lineDiffs(dmp, blockA, blockB);
  const blockRows = T.alignRows(blockLd, T.sourceLineCount(blockA), T.sourceLineCount(blockB));
  const blockIndices = T.changedRowIndices(blockRows);
  ok('导航块/连续修改产生相邻差异行', blockIndices.length >= 2 &&
     blockIndices.every((v, i) => i === 0 || v === blockIndices[i - 1] + 1), JSON.stringify(blockIndices));
  eq('导航块/连续修改合并为一块', T.groupDiffBlocks(blockIndices),
     [{ start: blockIndices[0], end: blockIndices[blockIndices.length - 1] }]);

  // 不相邻的改动仍是多块，计数不会把整个文件算成 1
  const splitA = 'a\nb\nc\nd\ne\nf\n';
  const splitB = 'A\nb\nc\nD\ne\nF\n';
  const splitLd = T.lineDiffs(dmp, splitA, splitB);
  const splitRows = T.alignRows(splitLd, T.sourceLineCount(splitA), T.sourceLineCount(splitB));
  eq('导航块/分散改动分成三块', T.groupDiffBlocks(T.changedRowIndices(splitRows)).length, 3);

  // 折叠行现在直接把“未改动 + 行数”写进 textarea，点击即可展开
  ok('折叠/折叠行在文本框中可见未改动', T.FOLD.indexOf('未改动') !== -1, T.FOLD);
  ok('折叠/可见文案仍被识别为折叠行', T.isFoldLine(T.FOLD));
  eq('折叠/提示文案带折叠行数', T.foldLabel(20), '未改动 20 行（点击展开）');
  ok('折叠/带行数的文案仍被识别为折叠行', T.isFoldLine(T.foldLabel(20)));
  eq('折叠/普通文本不被误认成折叠行', T.isFoldLine('未改动 20 行'), false);

  const countPlan = T.foldRows(rows, leftModel, rightModel, 3, {});
  const countView = T.buildViewLines(countPlan.rows, leftModel, 'left', true, null);
  ok('折叠/视图行显示实际折叠行数', countView.some(l => l.fold && l.text === T.foldLabel(3)));

  // 末尾 \n 补出的空视觉行不能算进折叠行数，否则与顶部“相同 N 行”差 1
  const tailText = Array.from({ length: 20 }, (_, i) => 'T' + i).join('\n') + '\n';
  const tailChar = dmp.diff_main(tailText, tailText);
  const tailLd = T.lineDiffs(dmp, tailText, tailText);
  const tailStats = T.statsFromLineDiffs(tailLd);
  const tailRows = T.alignRows(tailLd, T.sourceLineCount(tailText), T.sourceLineCount(tailText));
  const tailPlan = T.foldRows(tailRows, T.buildSide(tailChar, 'left'), T.buildSide(tailChar, 'right'), 3, {});
  const tailFold = tailPlan.rows.filter(r => r.op === 'fold')[0];
  eq('行数统计/末尾空行不增加折叠行数', tailFold.foldCount, tailStats.eq);
  eq('行数统计/隐藏行仍保留末尾空行以便完整还原', tailFold.hidden.left.length, 21);

  const sameRows = [];
  for (let i = 0; i < 5; i++) sameRows.push({ op: 'eq', leftLine: i, rightLine: i });
  const samePlan = T.foldRows(sameRows, leftModel.slice(0, 5), rightModel.slice(0, 5), 3, {});
  eq('折叠/完全相同整篇压成一个折叠块', samePlan.rows.map(r => r.op), ['fold']);
  eq('折叠/完全相同折叠块保留全部隐藏行', samePlan.rows[0].hidden.left.length, 5);

  // 完全相同文本折叠后，点击展开应彻底去掉折叠行（按钮随即变回「折叠未改动」）
  const sameExpanded = T.foldRows(sameRows, leftModel.slice(0, 5), rightModel.slice(0, 5), 3, { r0: true });
  eq('折叠/完全相同整篇展开后不再有折叠行', sameExpanded.rows.filter(r => r.op === 'fold').length, 0);

  // 按钮文案要跟着“实际还有没有折叠行”，而不是内部 foldEnabled
  eq('按钮文案/有折叠行时显示展开全部', T.hasFoldLines([{ fold: false }, { fold: true }]), true);
  eq('按钮文案/展开最后一个后显示折叠未改动', T.hasFoldLines([{ fold: false }, { fold: false }]), false);

  // 只有点在「未改动（点击展开）」文字上才展开，点同一行右侧空白不展开
  eq('折叠点击/点在文字上命中', T.foldLabelHit(20, 10, 120, 20, 0), true);
  eq('折叠点击/点在文字右侧空白不命中', T.foldLabelHit(200, 10, 120, 20, 0), false);
  eq('折叠点击/点在其他行不命中', T.foldLabelHit(20, 45, 120, 20, 0), false);
  eq('折叠点击/点在左侧内边距不命中', T.foldLabelHit(-3, 10, 120, 20, 0), false);

  // Tab 键：在可编辑行插入真正的制表符；选区替换；保护行拒绝写入
  const tv = 'aa\nbb\ncc';
  const tabAtCaret = T.tabInsertion(tv, 2, 2);
  eq('Tab/光标处插入制表符', tabAtCaret.text, 'aa\t\nbb\ncc');
  eq('Tab/光标移到制表符后', tabAtCaret.caret, 3);
  const tabSel = T.tabInsertion(tv, 1, 4);
  eq('Tab/有选区时用制表符替换选区', tabSel.text, 'a\tb\ncc');
  eq('Tab/替换选区后光标位置', tabSel.caret, 2);
  const phView = 'aa\n' + T.PH + '\ncc';
  const foldView = 'aa\n' + T.foldLabel(3) + '\ncc';
  eq('Tab/占位行不插入制表符', T.tabInsertion(phView, 3, 3), null);
  eq('Tab/折叠行不插入制表符', T.tabInsertion(foldView, 3, 3), null);
  eq('Tab/选区跨过占位行时拒绝写入', T.tabInsertion(phView, 2, 6), null);
  eq('Tab/非法选区返回空', T.tabInsertion(tv, 5, 2), null);
}

console.log('\n==== 结果: ' + pass + ' 通过, ' + fail + ' 失败 ====');
process.exit(fail ? 1 : 0);
