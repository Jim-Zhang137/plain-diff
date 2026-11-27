/* ============================================================
   PlainDiff 文本对比工具 v1.1.0 — 主逻辑
   ------------------------------------------------------------
   结构说明：
   1. 纯函数区（不依赖 DOM）：负责差异计算、按行拆分、统计、生成报告
      —— 便于单元测试，也便于后续改造。
   2. DOM 区：绑定按钮、渲染高亮层/行号/迷你标记条、滚动同步。
   3. 渲染原理：textarea 负责"编辑"，backdrop 负责"上色"，
      两者字体/行高/内边距完全一致，所以颜色能精确压在文字下面。
   ============================================================ */
(function () {
  'use strict';

  /* diff-match-patch 的操作码 */
  var DIFF_DELETE = -1;
  var DIFF_INSERT = 1;
  var DIFF_EQUAL = 0;

  /* ==========================================================
     一、纯函数区（不依赖 DOM，可在 Node 中直接测试）
     ========================================================== */

  /** HTML 转义（高亮层只用到 & < >） */
  function esc(s) {
    return String(s).replace(/[&<>]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;';
    });
  }

  /**
   * 统计一段文本包含多少"行"。
   * 规则：以 \n 分隔；末尾的 \n 不算多出一行。
   * 例："a" -> 1, "a\n" -> 1, "a\nb" -> 2, "" -> 0
   */
  function countLines(text) {
    if (!text) return 0;
    var n = 0;
    for (var i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) n++;
    }
    if (text.charCodeAt(text.length - 1) !== 10) n++;
    return n;
  }

  /**
   * 把字符级 diff 结果拆成"某一侧"的行模型。
   * @param {Array} diffs  diff_match_patch 的原始结果 [[op, text], ...]
   * @param {string} side  'left' 只保留 EQUAL+DELETE；'right' 只保留 EQUAL+INSERT
   * @returns {Array<{segs: Array<{text:string, cls:(null|'ins'|'del')}>, hasIns:boolean, hasDel:boolean}>}
   *
   * 注意：所有 segs 拼起来 + 换行 == 该侧原始文本，因此高亮层与 textarea 内容一一对应。
   */
  function buildSide(diffs, side) {
    var lines = [];
    var cur = { segs: [], hasIns: false, hasDel: false };
    lines.push(cur);

    function push(text, cls) {
      if (!text) return;
      var parts = text.split('\n');
      for (var i = 0; i < parts.length; i++) {
        if (i > 0) {
          cur = { segs: [], hasIns: false, hasDel: false };
          lines.push(cur);
        }
        var piece = parts[i];
        if (!piece) continue;
        cur.segs.push({ text: piece, cls: cls });
        if (cls === 'ins') cur.hasIns = true;
        if (cls === 'del') cur.hasDel = true;
      }
    }

    for (var k = 0; k < diffs.length; k++) {
      var op = diffs[k][0];
      var text = diffs[k][1];
      if (op === DIFF_EQUAL) push(text, null);
      else if (op === DIFF_DELETE && side === 'left') push(text, 'del');
      else if (op === DIFF_INSERT && side === 'right') push(text, 'ins');
    }
    return lines;
  }

  /** 不参与对比时（库加载失败）使用的普通行模型 */
  function plainSide(text) {
    var parts = text.split('\n');
    var lines = [];
    for (var i = 0; i < parts.length; i++) {
      lines.push({
        segs: parts[i] ? [{ text: parts[i], cls: null }] : [],
        hasIns: false,
        hasDel: false
      });
    }
    return lines;
  }

  /**
   * 按"行"做一次 diff，用于统计新增/删除/相同行，以及生成对比报告。
   * 使用 diff-match-patch 自带的 行->字符 映射，速度很快。
   */
  function lineDiffs(dmp, a, b) {
    if (!dmp) return [];
    try {
      // 统一补上末尾换行：否则"最后一行是否有换行"会让整行被误判为修改
      var na = a && a.charAt(a.length - 1) !== '\n' ? a + '\n' : a;
      var nb = b && b.charAt(b.length - 1) !== '\n' ? b + '\n' : b;

      var res = dmp.diff_linesToChars_(na, nb);
      var diffs = dmp.diff_main(res.chars1, res.chars2, false);
      dmp.diff_charsToLines_(diffs, res.lineArray);
      // 注意：这里不能再调用 diff_cleanupSemantic，
      // 它会把操作片段切到"行中间"，导致按 \n 统计行数失真。
      return diffs;
    } catch (err) {
      console.error('[PlainDiff] 行级 diff 计算失败：', err);
      return [];
    }
  }

  /**
   * 根据行级 diff 统计（两类口径，和 git 的 +/- 一致）：
   *   add = 新增行（右侧插入的行，含"原地修改"后的新行）
   *   del = 删除行（左侧被删掉的行，含"原地修改"前的旧行）
   *   eq  = 相同行（两侧逐行完全相等，空行也算一行）
   *
   * 守恒关系：eq + del = 左侧行数；eq + add = 右侧行数。
   * 注意：这里不做"删一行 + 加一行 = 修改"的折算。
   *       折算会让"这行算修改、那行算新增"的分界依赖配对规则，
   *       用户很难对上账；改一行就老实记 1 删除 + 1 新增。
   */
  function statsFromLineDiffs(diffs) {
    var out = { add: 0, del: 0, eq: 0 };
    var i = 0;
    while (i < diffs.length) {
      var op = diffs[i][0];
      if (op === DIFF_EQUAL) {
        out.eq += countLines(diffs[i][1]);
        i++;
        continue;
      }
      // 连续的 删除+新增 属于同一改动区，但两侧行数各记各的
      while (i < diffs.length && diffs[i][0] !== DIFF_EQUAL) {
        if (diffs[i][0] === DIFF_DELETE) out.del += countLines(diffs[i][1]);
        else if (diffs[i][0] === DIFF_INSERT) out.add += countLines(diffs[i][1]);
        i++;
      }
    }
    return out;
  }

  // 折叠完全由用户点击「折叠未改动」按钮决定：
  // 自动渲染（输入、导入、交换、清空、刷新）不改变当前折叠状态，绝不主动折叠。
  /**
   * 把行级 diff 映射成"左侧哪几行被删、右侧哪几行被插"。
   * 返回的行号（0 起）与 buildSide() 生成的行数组一一对应。
   *
   * 为什么需要它：字符级高亮只能给"真的删掉了字符"的行画红底，
   * 例如"支持并排对比 → 支持并排和行内对比"左侧一个字都没删，
   * 行级统计却记了 1 删除 + 1 新增。为了让整行底色、行号、迷你条
   * 和顶部统计对得上，必须再用行级 diff 补一次标记。
   */
  function lineLevelFlags(diffs) {
    var out = { del: Object.create(null), ins: Object.create(null) };
    var li = 0, ri = 0;
    for (var i = 0; i < diffs.length; i++) {
      var op = diffs[i][0];
      var n = countLines(diffs[i][1]);
      if (op === DIFF_EQUAL) {
        li += n;
        ri += n;
      } else if (op === DIFF_DELETE) {
        for (var d = 0; d < n; d++) out.del[li + d] = true;
        li += n;
      } else if (op === DIFF_INSERT) {
        for (var k = 0; k < n; k++) out.ins[ri + k] = true;
        ri += n;
      }
    }
    return out;
  }

  /**
   * 找出"对侧多出来的内容"在本侧文本中的位置（行号 + 列号，均从 0 起）。
   * 默认找右侧 INSERT 在左侧的位置；传 DIFF_DELETE 则找左侧 DELETE 在右侧的位置。
   * 纯插入/纯删除时本侧没有对应的字符级片段，必须单独记录位置，
   * 才能在本侧的"某两个字符之间"画窄占位符。
   * 规则：目标操作不推进游标，只记录当前位置；其余操作推进游标。
   */
  function insertionPoints(diffs, missingOp) {
    var target = typeof missingOp === 'number' ? missingOp : DIFF_INSERT;
    var out = [];
    var line = 0, col = 0;
    function advance(text) {
      for (var i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10) { line++; col = 0; }
        else col++;
      }
    }
    for (var k = 0; k < diffs.length; k++) {
      var op = diffs[k][0], text = diffs[k][1];
      if (op === target) out.push({ line: line, col: col });
      else advance(text);
    }
    return out;
  }

  /**
   * 占位行在 textarea 值里的标记：两个零宽空格。
   * 肉眼不可见，但能被 input 事件稳定识别，从而和普通空行区分开。
   */
  var PH = '\u200B\u200B';

  // 折叠行：提示文字直接写进 textarea，并带上被折叠的行数，方便判断值不值得展开。
  // 这行文字仍按折叠行跳过输入还原/复制，所以不会污染真实文本。
  var FOLD = '未改动（点击展开）';
  var FOLD_RE = /^未改动(?: \d+ 行)?（点击展开）$/;
  var FOLD_CONTEXT = 3;   // 差异前后各保留 3 行上下文

  function foldLabel(count) {
    return count > 0 ? '未改动 ' + count + ' 行（点击展开）' : FOLD;
  }

  function isPlaceholderLine(line) {
    return line === PH;
  }

  function isFoldLine(line) {
    return typeof line === 'string' && FOLD_RE.test(line);
  }

  function isProtectedLine(line) {
    return isPlaceholderLine(line) || isFoldLine(line);
  }

  function sourceLineCount(text) {
    return text === '' ? 0 : text.split('\n').length;
  }

  /**
   * 根据行级 diff 生成"对齐视图"的行序列。
   * 相同内容落在同一行；某侧多出来的行用占位行补齐。
   * op: eq=两侧都有, change=左右各一行(改了一行), del=仅左侧有, ins=仅右侧有
   */
  function alignRows(diffs, leftCount, rightCount) {
    var rows = [];
    var li = 0, ri = 0;
    var i = 0;
    while (i < diffs.length) {
      if (diffs[i][0] === DIFF_EQUAL) {
        var n = countLines(diffs[i][1]);
        for (var e = 0; e < n; e++) {
          rows.push({ op: 'eq', leftLine: li++, rightLine: ri++ });
        }
        i++;
        continue;
      }
      // 收集一个连续差异块里的删除行和新增行
      var dels = 0, adds = 0;
      while (i < diffs.length && diffs[i][0] !== DIFF_EQUAL) {
        var cnt = countLines(diffs[i][1]);
        if (diffs[i][0] === DIFF_DELETE) dels += cnt;
        else adds += cnt;
        i++;
      }
      // 一一配对：改一行时左右都显示真实内容，不产生占位行
      var pair = Math.min(dels, adds);
      for (var p = 0; p < pair; p++) {
        rows.push({ op: 'change', leftLine: li++, rightLine: ri++ });
      }
      for (var d = 0; d < dels - pair; d++) {
        rows.push({ op: 'del', leftLine: li++, rightLine: -1 });
      }
      for (var a = 0; a < adds - pair; a++) {
        rows.push({ op: 'ins', leftLine: -1, rightLine: ri++ });
      }
    }
    // 兜底：文本以 \n 结尾时，物理行(view)比行级 diff 的逻辑行多 1，
    // 这里补的是“末尾空视觉行”，不是差异，绝不能标成 change/del/ins。
    // 否则两段完全相同的文本只要以 \n 结尾，就会在最后一行出现幽灵 -/+。
    while (li < leftCount || ri < rightCount) {
      var both = li < leftCount && ri < rightCount;
      rows.push({
        op: both ? 'tail' : (li < leftCount ? 'tail-left' : 'tail-right'),
        leftLine: li < leftCount ? li++ : -1,
        rightLine: ri < rightCount ? ri++ : -1
      });
    }
    return rows;
  }

  function modelText(model, idx) {
    var m = model[idx];
    if (!m) return '';
    var segs = m.segs || [], out = '';
    for (var i = 0; i < segs.length; i++) out += segs[i].text;
    return out;
  }

  function isChangedRow(row) {
    return row.op === 'change' || row.op === 'del' || row.op === 'ins';
  }

  /** 文本以 \n 结尾时补出的末尾空视觉行，不是真实内容行，统计时不计入 */
  function isTailRow(row) {
    return row.op.indexOf('tail') === 0;
  }

  /**
   * 折叠未改动区域（纯函数）。
   * 只把连续“未改动行”压成一个折叠行；差异行及其前后 FOLD_CONTEXT 行永远保留。
   * 返回的 diffIndices 是“最终视图行号”，供差异导航直接使用。
   * expanded 里记录用户点开的折叠块 id（按原始对齐行号生成，稳定且不依赖渲染）。
   */
  function foldRows(rows, leftModel, rightModel, context, expanded) {
    var n = rows.length;
    var ctx = typeof context === 'number' ? context : FOLD_CONTEXT;
    expanded = expanded || Object.create(null);

    var keep = new Array(n);
    var last = -1e9, i;
    for (i = 0; i < n; i++) {
      if (isChangedRow(rows[i])) last = i;
      keep[i] = (i - last <= ctx);
    }
    var next = 1e9;
    for (i = n - 1; i >= 0; i--) {
      if (isChangedRow(rows[i])) next = i;
      if (next - i <= ctx) keep[i] = true;
    }

    function hiddenOf(run, side, model) {
      var out = [];
      for (var k = 0; k < run.length; k++) {
        var idx = side === 'left' ? run[k].leftLine : run[k].rightLine;
        if (idx >= 0 && model[idx]) out.push(modelText(model, idx));
      }
      return out;
    }

    var outRows = [], diffIndices = [];
    i = 0;
    while (i < n) {
      if (keep[i]) {
        if (isChangedRow(rows[i])) diffIndices.push(outRows.length);
        outRows.push(rows[i]);
        i++;
        continue;
      }
      var start = i;
      while (i < n && !keep[i]) i++;
      var run = rows.slice(start, i);
      var fid = 'r' + start;
      if (expanded[fid] || run.length < 2) {
        for (var r = 0; r < run.length; r++) {
          if (isChangedRow(run[r])) diffIndices.push(outRows.length);
          outRows.push(run[r]);
        }
        continue;
      }
      // 折叠行数只算真实内容行：末尾空视觉行（tail*）不属于任何 diff 统计，
      // 否则“相同 495 行”会显示成“未改动 496 行”。隐藏内容仍保留 tail 行，展开后文本完全还原。
      var logical = 0;
      for (var c = 0; c < run.length; c++) if (!isTailRow(run[c])) logical++;
      outRows.push({
        op: 'fold',
        foldId: fid,
        foldCount: logical,
        hidden: { left: hiddenOf(run, 'left', leftModel), right: hiddenOf(run, 'right', rightModel) }
      });
    }
    return { rows: outRows, diffIndices: diffIndices };
  }

  function changedRowIndices(rows) {
    var out = [];
    for (var i = 0; i < rows.length; i++) if (isChangedRow(rows[i])) out.push(i);
    return out;
  }

  /**
   * 把"逐行差异索引"合并成"连续差异块"：视图行号相邻的差异行算同一块。
   * 导航按块跳转：块内不再逐行停靠，一个连续块在计数里只算 1。
   * 入参按升序传入（changedRowIndices / foldRows.diffIndices 都是升序）。
   * @returns {Array<{start:number, end:number}>} 视图行号区间，含首尾
   */
  function groupDiffBlocks(indices) {
    var blocks = [];
    for (var i = 0; i < indices.length; i++) {
      var line = indices[i];
      var last = blocks[blocks.length - 1];
      if (last && line === last.end + 1) last.end = line;
      else blocks.push({ start: line, end: line });
    }
    return blocks;
  }

  /**
   * 把对齐行 + 某侧字符级行模型，拼成 textarea 里真正显示的行。
   * ensureEditable：本侧真实文本为空但对侧有内容时，第一行保留为可编辑空行，
   * 这样用户点击后可以直接粘贴，而不会被占位行保护拦住。
   */
  function buildViewLines(rows, model, side, ensureEditable, flags) {
    var key = side === 'left' ? 'leftLine' : 'rightLine';
    var flagKey = side === 'left' ? 'del' : 'ins';
    var out = [];
    var hasReal = false;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row.op === 'fold') {
        hasReal = true;   // 折叠行本身要保留，不能被“空侧可编辑首行”逻辑覆盖
        out.push({
          text: foldLabel(row.foldCount), placeholder: false, fold: true,
          foldId: row.foldId, foldCount: row.foldCount,
          hidden: row.hidden ? (row.hidden[side] || []) : [],
          segs: [], hasMark: false, lineNo: null, sign: ''
        });
        continue;
      }
      var srcIdx = row[key];
      if (srcIdx < 0 || !model[srcIdx]) {
        out.push({ text: PH, placeholder: true, segs: [], hasMark: false,
                   lineNo: null, sign: '' });
        continue;
      }
      hasReal = true;
      var m = model[srcIdx];
      var segs = m.segs || [];
      var text = '';
      for (var j = 0; j < segs.length; j++) text += segs[j].text;
      var charMark = side === 'left' ? m.hasDel : m.hasIns;
      // 纯插入/纯删除时，另一侧没有字符级片段，但整行仍要按行级 diff 上浅底色，
      // 否则“左侧多了 1 个字”时右侧会完全没有视觉反馈。
      var lineMark = !!(flags && flags[flagKey] && flags[flagKey][srcIdx]);
      // eq / tail* 都是“中性行”：不显示 -/+ 符号，迷你条也不该有标记。
      // 真正的差异行（change/del/ins）才按侧别打符号。
      var neutral = row.op === 'eq' || row.op.indexOf('tail') === 0;
      out.push({
        text: text,
        placeholder: false,
        segs: segs,
        hasMark: !!(charMark || lineMark),
        lineNo: srcIdx + 1,
        sign: neutral ? '' : (side === 'left' ? '-' : '+')
      });
    }
    // 空侧全部是占位行时，把第一行换成真正的空行（viewToSource 仍还原成空文本）
    if (!hasReal && ensureEditable && out.length) {
      out[0] = {
        text: '', placeholder: false, segs: [], hasMark: false,
        lineNo: null, sign: '', editableBlank: true
      };
    }
    return out;
  }

  function viewLinesToText(viewLines) {
    var out = [];
    for (var i = 0; i < viewLines.length; i++) out.push(viewLines[i].text);
    return out.join('\n');
  }

  /** 视图文本 -> 真实文本：去掉占位行（以及误粘进真实行的标记字符） */
  function viewToSource(view) {
    var lines = String(view).split('\n');
    var real = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (isProtectedLine(line)) continue;
      if (line.slice(0, PH.length) === PH) line = line.slice(PH.length);
      real.push(line);
    }
    return real.join('\n');
  }

  /**
   * 用户输入走这条还原路径：只丢弃“整行都是占位标记”的行。
   * 旧 viewToSource() 还会剥掉任意真实行开头的 PH 前缀，会把用户自己粘贴的
   * 零宽空格误删；复制路径（onCopy）仍用 viewToSource() 清理复制出的选区。
   */
  function viewToSourceForInput(view, foldHidden) {
    var lines = String(view).split('\n');
    var real = [], fi = 0;
    for (var i = 0; i < lines.length; i++) {
      if (isFoldLine(lines[i])) {
        var hidden = foldHidden && foldHidden[fi++];
        if (hidden) for (var k = 0; k < hidden.length; k++) real.push(hidden[k]);
        continue;
      }
      if (!isPlaceholderLine(lines[i])) real.push(lines[i]);
    }
    return real.join('\n');
  }

  function lineStarts(view) {
    var starts = [0];
    for (var i = 0; i < view.length; i++) {
      if (view.charCodeAt(i) === 10) starts.push(i + 1);
    }
    return starts;
  }

  function lineIndexAt(view, pos) {
    var n = 0;
    for (var i = 0; i < pos && i < view.length; i++) {
      if (view.charCodeAt(i) === 10) n++;
    }
    return n;
  }

  function isPlaceholderAt(view, lineIdx) {
    var lines = view.split('\n');
    return lineIdx >= 0 && lineIdx < lines.length && isPlaceholderLine(lines[lineIdx]);
  }

  function isFoldAt(view, lineIdx) {
    var lines = view.split('\n');
    return lineIdx >= 0 && lineIdx < lines.length && isFoldLine(lines[lineIdx]);
  }

  /**
   * 纯命中判定：x/y 是已换算好的“内容区坐标”（去掉内边距、加上滚动量）。
   * 只有点在折叠行文字的水平范围内、且在这一行的高度内才算命中。
   */
  function foldLabelHit(x, y, width, lineHeight, lineIdx) {
    return y >= lineIdx * lineHeight && y < (lineIdx + 1) * lineHeight &&
           x >= 0 && x <= width + 2;   // 2px 容差，方便点到最后一个字
  }

  function isProtectedAt(view, lineIdx) {
    var lines = view.split('\n');
    return lineIdx >= 0 && lineIdx < lines.length && isProtectedLine(lines[lineIdx]);
  }

  function lineKindAt(view, lineIdx) {
    if (isFoldAt(view, lineIdx)) return 'fold';
    if (isPlaceholderAt(view, lineIdx)) return 'placeholder';
    return null;
  }

  /**
   * Tab 键：在可编辑位置插入一个制表符（有选区时替换选区）。
   * 选区只要碰到占位行/折叠行就拒绝，避免把保护标记当普通文本删掉。
   */
  function tabInsertion(view, start, end) {
    if (typeof start !== 'number' || typeof end !== 'number') return null;
    if (start < 0 || end < start || end > view.length) return null;
    var first = lineIndexAt(view, start);
    var last = lineIndexAt(view, end);
    for (var i = first; i <= last; i++) {
      if (isProtectedAt(view, i)) return null;
    }
    return { text: view.slice(0, start) + '\t' + view.slice(end), caret: start + 1 };
  }

  /** 视图光标位置 -> 真实文本位置（跳过占位行；折叠行按隐藏内容展开计入） */
  function caretViewToSource(view, pos, phSet, foldHidden) {
    var lines = view.split('\n');
    var starts = lineStarts(view);
    var li = 0;
    while (li + 1 < starts.length && starts[li + 1] <= pos) li++;
    var within = pos - starts[li];
    var out = 0, fi = 0;
    for (var j = 0; j < li; j++) {
      if (isFoldLine(lines[j])) {
        var hidden = foldHidden && foldHidden[fi++];
        if (hidden) for (var k = 0; k < hidden.length; k++) out += hidden[k].length + 1;
        continue;
      }
      if (!isPlaceholderLine(lines[j])) out += lines[j].length + 1;
    }
    if (isFoldLine(lines[li])) return Math.max(0, out);   // 光标落在折叠行 -> 映射到隐藏区开头
    if (!isPlaceholderLine(lines[li])) out += Math.min(within, lines[li].length);
    return Math.max(0, out);
  }

  /** 真实文本位置 -> 视图光标位置（插回占位行/折叠行的偏移） */
  function caretSourceToView(view, pos, phSet, foldHidden) {
    var lines = view.split('\n');
    var viewOff = 0, srcOff = 0, fi = 0;
    for (var i = 0; i < lines.length; i++) {
      var len = lines[i].length;
      if (isFoldLine(lines[i])) {
        var hidden = foldHidden && foldHidden[fi++];
        if (hidden) {
          for (var k = 0; k < hidden.length; k++) {
            if (pos <= srcOff + hidden[k].length) return viewOff;
            srcOff += hidden[k].length + 1;
          }
        }
        viewOff += len + 1;
        continue;
      }
      if (phSet && phSet[i]) {
        // 占位行在视图里占字符，但在真实文本里不占
        viewOff += len + 1;
        continue;
      }
      if (pos <= srcOff + len) return viewOff + (pos - srcOff);
      srcOff += len + 1;
      viewOff += len + 1;
      if (pos < srcOff) return viewOff - 1;
    }
    return view.length;
  }

  /** 取一组文本的差异统计 */
  function computeStats(dmp, a, b) {
    return statsFromLineDiffs(lineDiffs(dmp, a, b));
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function formatTime(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
           ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  /**
   * 把行级 diff 变成"带前缀的文本行"，用于生成报告明细。
   * 前缀：'  ' 相同 / '- ' 删除 / '+ ' 新增。
   * 说明：行级 diff 偶尔会出现"上一段结尾没有换行、下一段以换行开头"的情况，
   *       这里把这种开头换行当作上一行的结束符吃掉，避免出现多余的空行。
   */
  function buildDetailRows(diffs) {
    var rows = [];
    var open = Object.create(null);
    var atLineStart = true;

    function closeAll() { open = Object.create(null); }

    function feed(prefix, text) {
      if (!text) return;
      var i = 0;
      while (i < text.length) {
        var nl = text.indexOf('\n', i);
        var row = open[prefix];
        if (!row) {
          row = { prefix: prefix, text: '' };
          rows.push(row);
          open[prefix] = row;
        }
        if (nl === -1) {
          row.text += text.slice(i);
          return;
        }
        row.text += text.slice(i, nl);
        closeAll();
        i = nl + 1;
      }
    }

    for (var k = 0; k < diffs.length; k++) {
      var op = diffs[k][0];
      var text = diffs[k][1];
      var prefix = op === DIFF_DELETE ? '- ' : op === DIFF_INSERT ? '+ ' : '  ';

      if (k > 0) {
        var p = diffs[k - 1][0];
        var prevPrefix = p === DIFF_DELETE ? '- ' : p === DIFF_INSERT ? '+ ' : '  ';
        if (prevPrefix !== prefix) closeAll();
      }
      if (!atLineStart && text.charAt(0) === '\n') {
        closeAll();
        atLineStart = true;
        text = text.slice(1);
      }
      feed(prefix, text);
      if (text.length) atLineStart = text.charAt(text.length - 1) === '\n';
    }
    return rows;
  }

  /**
   * 生成"复制对比结果"用的纯文本报告。
   * 明细采用类似 unified diff 的前缀：'  ' 相同 / '- ' 删除 / '+ ' 新增
   */
  function buildReport(dmp, a, b) {
    var ld = lineDiffs(dmp, a, b);
    var s = statsFromLineDiffs(ld);
    var out = [];
    var line = '==================================================';

    out.push(line);
    out.push('  PlainDiff 文本对比报告  v1.1.0');
    out.push(line);
    out.push('生成时间：' + formatTime(new Date()));
    out.push('原始文本：' + (a === '' ? 0 : a.split('\n').length) + ' 行 / ' + a.length + ' 字符');
    out.push('新文本：  ' + (b === '' ? 0 : b.split('\n').length) + ' 行 / ' + b.length + ' 字符');
    out.push('差异统计：新增 ' + s.add + ' 行，删除 ' + s.del + ' 行，相同 ' + s.eq + ' 行');
    out.push('--------------------------------------------------');
    out.push('说明：  = 相同行    - 仅原始文本有    + 仅新文本有');
    out.push('--------------------------------------------------');

    var LIMIT = 3000;   // 防止报告过长
    var truncated = false;
    var rows = buildDetailRows(ld);

    for (var i = 0; i < rows.length; i++) {
      if (i >= LIMIT) { truncated = true; break; }
      out.push(rows[i].prefix + rows[i].text);
    }
    if (truncated) out.push('……（内容过长，明细已截断，完整内容请在页面内查看）');

    out.push(line);
    out.push('所有内容均在浏览器本地处理，未上传任何服务器。');
    return out.join('\r\n');
  }

  /* ==========================================================
     二、DOM 区
     ========================================================== */

  var el = {};              // DOM 缓存
  var dmp = null;           // diff_match_patch 实例
  var renderTimer = null;   // 输入防抖
  var toastTimer = null;
  var activeSide = 'left';  // 最后被用户滚动/编辑的一侧，渲染后以它为准重新对齐
  // 真实文本（不含占位行）是唯一数据源；textarea 里显示的是加了占位行的"对齐视图"
  var source = { left: '', right: '' };
  var viewInfo = { left: null, right: null };      // { text, phSet }
  var pendingCaret = { left: null, right: null };  // 渲染后要恢复的光标（真实文本坐标）
  var composing = { left: false, right: false };     // 中文输入法组词期间不重写对应侧的 textarea
  // 滚动状态：last = 上一次实际位置；expected = 我们程序写入的位置（用来识别浏览器抛回的 scroll 回声）
  var lastScroll = { left: { top: -1, left: -1 }, right: { top: -1, left: -1 } };
  var expectedScroll = { left: null, right: null };

  // 新增功能状态：折叠只由用户点击按钮触发，自动渲染不折叠
  var foldEnabled = false;                   // 当前视图是否折叠（仅用户点击按钮时改变）
  var hasVisibleFolds = false;               // 当前视图里是否真的还有折叠行
  var expandedFolds = Object.create(null);   // 用户点开过的折叠块 id
  var diffBlocks = [];                       // 当前视图中的连续差异块（导航按块跳转）
  var diffCursor = -1;                       // 当前定位到第几个差异块（0 起）

  function $(id) { return document.getElementById(id); }

  /** 视图里是否还存在折叠行（按钮文案要跟着它变，而不是跟着内部状态） */
  function hasFoldLines(viewLines) {
    for (var i = 0; i < viewLines.length; i++) {
      if (viewLines[i].fold) return true;
    }
    return false;
  }

  /* ---------- 渲染 ---------- */

  /** 把 textarea 换成对齐视图，并尽量恢复光标位置 */
  function replaceView(side, text, viewLines, foldHidden, foldIds) {
    var ed = side === 'left' ? el.textA : el.textB;
    var phSet = [];
    for (var i = 0; i < viewLines.length; i++) phSet[i] = !!viewLines[i].placeholder;
    viewInfo[side] = {
      text: text, phSet: phSet,
      foldHidden: foldHidden || [], foldIds: foldIds || [],
      viewLines: viewLines || []
    };

    // 先取用并清空待恢复光标：即使下面因内容未变而早退，也不能把旧坐标留到下一次渲染，
    // 否则拖入文件/导入等“聚焦状态下重写视图”的操作会把光标跳到上一次打字的旧位置。
    var pc = pendingCaret[side];
    pendingCaret[side] = null;

    if (!ed || ed.value === text) return;   // 内容没变就不重写，免得打断光标和输入法
    var focused = document.activeElement === ed;
    var ss = ed.selectionStart, se = ed.selectionEnd;
    if (pc && focused) {
      ss = caretSourceToView(text, pc.start, phSet, viewInfo[side].foldHidden);
      se = caretSourceToView(text, pc.end, phSet, viewInfo[side].foldHidden);
    }
    ed.value = text;
    if (pc && focused) {
      try { ed.setSelectionRange(ss, se); } catch (e) { /* 某些浏览器在失焦时会拒绝 */ }
    }
  }

  /** 渲染高亮背景层（只有颜色，文字透明） */
  function renderBackdrop(node, viewLines, kind, marksInView) {
    if (!node) return;
    if (!viewLines.length) { node.innerHTML = ''; return; }
    var clsName = kind === 'del' ? 'del' : 'add';   // CSS 里绿色叫 is-add，不是 is-ins

    // 按视图行归集窄占位符：左侧来自右侧 INSERT，右侧来自左侧 DELETE
    var marksByLine = Object.create(null);
    if (marksInView) {
      for (var p = 0; p < marksInView.length; p++) {
        var pt = marksInView[p];
        if (!marksByLine[pt.line]) marksByLine[pt.line] = [];
        marksByLine[pt.line].push(pt.col);
      }
      for (var key in marksByLine) {
        marksByLine[key].sort(function (x, y) { return x - y; });
      }
    }

    // 零宽空格保证空 span 有行盒，但完全不占宽度，不会把文字挤偏；
    // 右侧的窄占位符用 is-add 改成深绿色。
    var MARK = '<span class="ins-placeholder' + (kind === 'ins' ? ' is-add' : '') +
               '">&#8203;</span>';
    var html = '';
    for (var i = 0; i < viewLines.length; i++) {
      var ln = viewLines[i];
      if (ln.fold) {
        // 提示文字已直接写在 textarea 里，这一层只负责浅蓝条纹底色
        html += '<div class="bline is-fold"></div>';
        continue;
      }
      if (ln.placeholder) {
        html += '<div class="bline is-placeholder"><span class="ph-dot">\u00b7</span></div>';
        continue;
      }
      var cls = ln.hasMark ? ' is-' + clsName : '';
      if (ln.editableBlank) cls += ' is-editable-blank';
      html += '<div class="bline' + cls + '">';

      var marks = marksByLine[i] || [];
      var mi = 0, col = 0;
      for (var j = 0; j < ln.segs.length; j++) {
        var seg = ln.segs[j];
        var text = seg.text;
        var pos = 0;
        while (pos < text.length) {
          while (mi < marks.length && marks[mi] === col) {
            html += MARK;
            mi++;
          }
          if (mi < marks.length && marks[mi] < col) { mi++; continue; }
          var take = Math.min(text.length - pos,
                              (mi < marks.length ? marks[mi] : Infinity) - col);
          if (take <= 0) break;
          var piece = text.substr(pos, take);
          html += seg.cls ? '<span class="seg-' + seg.cls + '">' + esc(piece) + '</span>' : esc(piece);
          pos += take;
          col += take;
        }
      }
      // 插入点正好落在该行末尾（换行符之前）
      while (mi < marks.length && marks[mi] === col) {
        html += MARK;
        mi++;
      }
      html += '</div>';
    }
    node.innerHTML = html;
  }

  /** 把"真实行号"映射成"对齐视图行号"，占位行/可编辑空行不接收标记 */
  function toViewPoints(points, viewLines) {
    var srcToView = Object.create(null);
    for (var i = 0; i < viewLines.length; i++) {
      if (viewLines[i].lineNo != null) srcToView[viewLines[i].lineNo - 1] = i;
    }
    var out = [];
    for (var k = 0; k < points.length; k++) {
      var viewLine = srcToView[points[k].line];
      if (viewLine != null) out.push({ line: viewLine, col: points[k].col });
    }
    return out;
  }

  /** 渲染行号栏：行号 + 差异符号（- 删除 / + 新增 / 空 相同）；占位行没有行号 */
  function renderGutter(node, viewLines, kind) {
    if (!node) return;
    var clsName = kind === 'del' ? 'del' : 'add';   // 同上：右侧行号也要用 is-add
    var html = '';
    for (var i = 0; i < viewLines.length; i++) {
      var ln = viewLines[i];
      if (ln.fold) {
        html += '<div class="gutter-line is-fold" title="点击展开这 ' + ln.foldCount +
                ' 行未改动内容（文本框里的「未改动」也可点击）"><span class="fold-mark">\u22ef</span></div>';
        continue;
      }
      if (ln.placeholder) {
        html += '<div class="gutter-line is-placeholder"></div>';
        continue;
      }
      if (ln.editableBlank) {
        // 可编辑空行不属于真实文本，不显示行号，但保留同样高度供光标定位
        html += '<div class="gutter-line is-editable-blank"></div>';
        continue;
      }
      html += '<div class="gutter-line' + (ln.sign ? ' is-' + clsName : '') + '">' +
              '<span class="ln">' + ln.lineNo + '</span>' +
              '<span class="sign">' + ln.sign + '</span>' +
              '</div>';
    }
    node.innerHTML = html;
  }

  /**
   * 渲染迷你差异标记条（右侧概览）。
   * 位置必须按"像素"算，不能按百分比：编辑器是固定行高 20px，
   * 但容器会被 flex 拉到整个面板高度，用百分比会把标记拉伸铺满，
   * 和左侧整行底色完全对不上。偏移 = 上内边距 + 行号 * 行高，
   * 再整体随 textarea 的 scrollTop 平移。
   */
  function renderMinimap(node, viewLines, kind, ed) {
    if (!node) return;
    node.title = '点击跳转到最近的差异';
    var total = viewLines.length;
    if (!total) { node.innerHTML = ''; return; }

    var cs = (ed && window.getComputedStyle) ? window.getComputedStyle(ed) : null;
    var lineHeight = cs ? (parseFloat(cs.lineHeight) || 20) : 20;
    var padTop = cs ? (parseFloat(cs.paddingTop) || 0) : 0;

    function marked(i) {
      return !!viewLines[i].sign;
    }
    var html = '<div class="minimap-inner">';
    var i = 0;
    while (i < total) {
      if (!marked(i)) { i++; continue; }
      var j = i;
      while (j < total && marked(j)) j++;
      var top = padTop + i * lineHeight;
      var h = Math.max((j - i) * lineHeight, 2);
      html += '<div class="mark mark-' + kind + '" style="top:' + top.toFixed(1) +
              'px;height:' + h.toFixed(1) + 'px"></div>';
      i = j;
    }
    html += '</div>';
    node.innerHTML = html;
  }

  /**
   * 让高亮层、行号栏、迷你条跟随 textarea 的滚动位置。
   * 三者都用 translate 平移内层，不再用 scrollTop：
   * textarea 有横向滚动条占位而高亮层没有，用 scrollTop 会被浏览器各自夹紧，
   * 滚到底部时行会差一个滚动条的高度。
   */
  function syncLayers(side) {
    var ed = side === 'left' ? el.textA : el.textB;
    var bd = side === 'left' ? el.backdropInnerLeft : el.backdropInnerRight;
    var gt = side === 'left' ? el.gutterInnerLeft : el.gutterInnerRight;
    var mp = side === 'left' ? el.mapLeft : el.mapRight;
    if (!ed) return;
    var top = 'translateY(' + (-ed.scrollTop) + 'px)';
    if (bd) bd.style.transform = 'translate(' + (-ed.scrollLeft) + 'px,' + (-ed.scrollTop) + 'px)';
    if (gt) gt.style.transform = top;
    if (mp && mp.firstChild) mp.firstChild.style.transform = top;
  }

  /** 主渲染流程：计算差异 -> 生成对齐视图 -> 渲染四层 -> 更新统计 */
  function render() {
    if (!el.textA || !el.textB) return;

    var a = source.left;
    var b = source.right;
    var diffs = null;

    if (dmp) {
      try {
        diffs = dmp.diff_main(a, b);
        dmp.diff_cleanupSemantic(diffs);
      } catch (err) {
        console.error('[PlainDiff] 字符级 diff 计算失败：', err);
        diffs = null;
      }
    }

    var leftModel = diffs ? buildSide(diffs, 'left') : plainSide(a);
    var rightModel = diffs ? buildSide(diffs, 'right') : plainSide(b);
    var ld = dmp ? lineDiffs(dmp, a, b) : [];
    var flags = dmp ? lineLevelFlags(ld) : null;
    var stats = dmp ? statsFromLineDiffs(ld) : { add: 0, del: 0, eq: 0 };

    // 行级对齐：相同内容落在同一行，多出来的一侧补占位行
    var baseRows = alignRows(ld, sourceLineCount(a), sourceLineCount(b));
    // 折叠是可选视图层：关闭时走和以前完全一样的 baseRows，不改动任何原有逻辑
    var foldPlan = foldEnabled
      ? foldRows(baseRows, leftModel, rightModel, FOLD_CONTEXT, expandedFolds)
      : { rows: baseRows, diffIndices: changedRowIndices(baseRows) };
    var rows = foldPlan.rows;

    // 相邻差异行合并成一块：连续几行改动只算 1 个差异，导航整块跳过
    diffBlocks = groupDiffBlocks(foldPlan.diffIndices);
    diffCursor = -1;

    var viewLeft = buildViewLines(rows, leftModel, 'left', b !== '', flags);
    var viewRight = buildViewLines(rows, rightModel, 'right', a !== '', flags);
    var viewTextA = viewLinesToText(viewLeft);
    var viewTextB = viewLinesToText(viewRight);

    // 按钮文案取决于“当前视图里还有没有折叠行”，局部展开到最后一个后也要及时变回「折叠未改动」
    hasVisibleFolds = hasFoldLines(viewLeft) || hasFoldLines(viewRight);

    // 折叠块的隐藏内容和 id 按视图行序收集，输入还原/光标映射/点击展开都靠它
    var foldHidden = { left: [], right: [] }, foldIds = [];
    for (var fi = 0; fi < viewLeft.length; fi++) {
      var vl = viewLeft[fi];
      foldIds[fi] = vl.fold ? vl.foldId : null;
      if (vl.fold) foldHidden.left.push(vl.hidden || []);
      if (viewRight[fi] && viewRight[fi].fold) foldHidden.right.push(viewRight[fi].hidden || []);
    }

    // 窄占位点从"真实行号"映射到"对齐视图行号"
    var leftMarks = diffs ? toViewPoints(insertionPoints(diffs), viewLeft) : [];
    var rightMarks = diffs ? toViewPoints(insertionPoints(diffs, DIFF_DELETE), viewRight) : [];

    replaceView('left', viewTextA, viewLeft, foldHidden.left, foldIds);
    replaceView('right', viewTextB, viewRight, foldHidden.right, foldIds);

    renderBackdrop(el.backdropInnerLeft, viewLeft, 'del', leftMarks);
    renderBackdrop(el.backdropInnerRight, viewRight, 'ins', rightMarks);
    renderGutter(el.gutterInnerLeft, viewLeft, 'del');
    renderGutter(el.gutterInnerRight, viewRight, 'ins');
    renderMinimap(el.mapLeft, viewLeft, 'del', el.textA);
    renderMinimap(el.mapRight, viewRight, 'ins', el.textB);

    // 行数口径与统计保持一致：末尾的 \n 是行终止符，不额外算一行。
    // alignRows 仍用 sourceLineCount 保留末尾空视觉行，保证 textarea 值与真实文本一致。
    el.countLeft.textContent = countLines(a) + ' 行';
    el.countRight.textContent = countLines(b) + ' 行';

    el.statAdd.textContent = stats.add;
    el.statDel.textContent = stats.del;
    el.statEq.textContent = stats.eq;

    // 折叠按钮文案 + 导航计数：完全以当前可见折叠行为准
    if (el.btnFold) {
      el.btnFold.disabled = false;
      el.btnFold.textContent = hasVisibleFolds ? '展开全部' : '折叠未改动';
      el.btnFold.title = hasVisibleFolds
        ? '展开所有被折叠的未改动区域，恢复完整可编辑视图；展开后编辑不会自动折叠'
        : '折叠连续的未改动区域；两侧完全相同时也会显示「未改动（点击展开）」';
      if (el.btnFold.setAttribute) el.btnFold.setAttribute('aria-pressed', hasVisibleFolds ? 'true' : 'false');
    }
    updateDiffNav();

    // 内容变化后 scrollTop 可能被浏览器夹紧，按最后操作的一侧重新对齐
    reconcileScroll();
  }

  /* ---------- 差异导航 / 折叠控制 ---------- */

  function editorMetrics() {
    var ed = el.textA;
    var cs = (ed && window.getComputedStyle) ? window.getComputedStyle(ed) : null;
    return {
      lineHeight: cs ? (parseFloat(cs.lineHeight) || 20) : 20,
      padTop: cs ? (parseFloat(cs.paddingTop) || 0) : 0
    };
  }

  function updateDiffNav() {
    var total = diffBlocks.length;   // 连续差异行算一块，只计 1
    if (el.diffTotal) el.diffTotal.textContent = total;
    if (el.diffCur) el.diffCur.textContent = diffCursor >= 0 ? diffCursor + 1 : 0;
    if (el.btnPrevDiff) el.btnPrevDiff.disabled = total === 0;
    if (el.btnNextDiff) el.btnNextDiff.disabled = total === 0;
  }

  /** 清掉旧的当前块标记（切换块或重算时调用，不设定时器，选中框会一直保留） */
  function clearCurrentBlock() {
    [el.backdropInnerLeft, el.backdropInnerRight, el.gutterInnerLeft, el.gutterInnerRight].forEach(function (node) {
      if (!node) return;
      for (var i = 0; i < node.children.length; i++) {
        node.children[i].classList.remove('is-current', 'cur-first', 'cur-last');
      }
    });
  }

  /**
   * 给整个差异块画一个选中框，持续显示直到跳转/重算。
   * 首行加 cur-first（上边）、末行加 cur-last（下边），中间行只保留左右边，
   * CSS 拼起来就是一个完整矩形，而不是每行各一个小框。
   */
  function markCurrentBlock(start, end) {
    clearCurrentBlock();
    [el.backdropInnerLeft, el.backdropInnerRight, el.gutterInnerLeft, el.gutterInnerRight].forEach(function (node) {
      if (!node) return;
      var from = Math.max(0, start), to = Math.min(end, node.children.length - 1);
      for (var i = from; i <= to; i++) {
        var line = node.children[i];
        line.classList.add('is-current');
        if (i === from) line.classList.add('cur-first');
        if (i === to) line.classList.add('cur-last');
      }
    });
  }

  /** 把差异块滚到视野中间；单行时与原逐行跳转的位置完全一致 */
  function scrollBothToRange(start, end) {
    var m = editorMetrics();
    var top = m.padTop + ((start + end) / 2) * m.lineHeight - (el.textA.clientHeight - m.lineHeight) / 2;
    var maxA = Math.max(0, el.textA.scrollHeight - el.textA.clientHeight);
    var maxB = Math.max(0, el.textB.scrollHeight - el.textB.clientHeight);
    el.textA.scrollTop = Math.max(0, Math.min(top, maxA));
    el.textB.scrollTop = Math.max(0, Math.min(top, maxB));
    // 程序滚动后登记为“已见过”，避免被 onEditorScroll 当成用户滚动反向拉扯
    expectedScroll.left = expectedScroll.right = null;
    lastScroll.left = { top: el.textA.scrollTop, left: el.textA.scrollLeft };
    lastScroll.right = { top: el.textB.scrollTop, left: el.textB.scrollLeft };
    syncLayers('left');
    syncLayers('right');
  }

  function applyDiffCursor() {
    var block = diffBlocks[diffCursor];
    scrollBothToRange(block.start, block.end);
    markCurrentBlock(block.start, block.end);
    updateDiffNav();
    var size = block.end > block.start ? '（连续 ' + (block.end - block.start + 1) + ' 行算 1 块）' : '';
    toast('差异 ' + (diffCursor + 1) + ' / ' + diffBlocks.length + size +
          (foldEnabled ? '（折叠视图）' : ''));
  }

  /** step=1 下一个，-1 上一个；首尾循环，每次跨过整个连续差异块 */
  function gotoDiff(step) {
    var total = diffBlocks.length;
    if (!total) { toast('当前没有差异可跳转'); return; }
    if (diffCursor < 0) diffCursor = step > 0 ? 0 : total - 1;
    else diffCursor = (diffCursor + step + total) % total;
    applyDiffCursor();
  }

  /** 点击迷你条：跳到离点击位置最近的差异块（点在块内就定位到该块） */
  function jumpToNearbyDiff(viewLine) {
    var total = diffBlocks.length;
    if (!total) { toast('当前没有差异可跳转'); return; }
    var best = 0, bestDist = Infinity;
    for (var i = 0; i < total; i++) {
      var b = diffBlocks[i];
      var d = viewLine < b.start ? b.start - viewLine : (viewLine > b.end ? viewLine - b.end : 0);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    diffCursor = best;
    applyDiffCursor();
  }

  function toggleFold() {
    // 按“当前有没有折叠行”决定动作，保证按钮文案和实际效果一致
    foldEnabled = !hasVisibleFolds;
    expandedFolds = Object.create(null);
    clearTimeout(renderTimer);
    render();
    toast(foldEnabled
      ? '已折叠未改动区域，保留差异前后各 3 行；点击「未改动」或「⋯」可单独展开'
      : '已展开全部内容，可正常编辑');
  }

  function expandFold(foldId) {
    if (!foldId) return;
    expandedFolds[foldId] = true;
    clearTimeout(renderTimer);
    render();
    // 已展开到没有任何折叠行时，回到未折叠状态：
    // 按钮显示「折叠未改动」就代表真的没折叠，后续编辑绝不自动折叠。
    if (!hasVisibleFolds) {
      foldEnabled = false;
      expandedFolds = Object.create(null);
    }
    toast('已展开该区域，可正常编辑');
  }

  function scheduleRender(delay) {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, typeof delay === 'number' ? delay : 150);
  }

  /* ---------- 交互反馈 ---------- */

  function toast(msg) {
    if (!el.toast) return;
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.toast.classList.remove('show');
    }, 1900);
  }

  function showBanner(msg) {
    if (!el.banner) return;
    el.banner.textContent = msg;
    el.banner.classList.add('show');
  }

  /* ---------- 滚动同步 ---------- */

  /**
   * 把 src 的滚动位置复制到 dst（横向也一起），dst 到头就停在它的最大值。
   * 只有真的写入了才记下 expected：浏览器随后会抛回一个 scroll 事件，
   * 用"值恰好等于指纹"来认出它，避免 A→B→A 来回拉扯。
   */
  function copyScroll(src, dst, dstSide) {
    if (!src || !dst) return;
    var maxTop = Math.max(0, dst.scrollHeight - dst.clientHeight);
    var top = Math.max(0, Math.min(src.scrollTop, maxTop));
    var maxLeft = Math.max(0, dst.scrollWidth - dst.clientWidth);
    var left = Math.max(0, Math.min(src.scrollLeft, maxLeft));

    if (Math.abs(dst.scrollTop - top) > 0.5 || Math.abs(dst.scrollLeft - left) > 0.5) {
      dst.scrollTop = top;
      dst.scrollLeft = left;
      // 浏览器可能夹紧，读回真实值作为回声指纹
      expectedScroll[dstSide] = { top: dst.scrollTop, left: dst.scrollLeft };
      // 不能只依赖浏览器补发的 scroll 事件（部分场景会丢失），立即把对侧各层对齐
      syncLayers(dstSide);
    }
  }

  function onEditorScroll(side) {
    // 即使这次是被夹紧的"空滚动"，本侧各层也要跟上当前实际位置
    syncLayers(side);
    var ed = side === 'left' ? el.textA : el.textB;
    if (!ed) return;

    var top = ed.scrollTop;
    var left = ed.scrollLeft;
    var last = lastScroll[side];
    var changed = Math.abs(top - last.top) > 0.5 || Math.abs(left - last.left) > 0.5;

    var exp = expectedScroll[side];
    var isEcho = !!exp && Math.abs(top - exp.top) <= 0.5 && Math.abs(left - exp.left) <= 0.5;
    lastScroll[side] = { top: top, left: left };
    if (isEcho) {
      expectedScroll[side] = null;
      return;                            // 程序写入的回声，不再往回同步
    }
    if (exp) expectedScroll[side] = null; // 用户真实滚动，旧指纹作废

    // 旧版用 30ms 时间窗抑制回声，会把紧接着在对侧的滚动吞掉；
    // 现在靠指纹识别回声，靠"实际没动就不同步"避免夹紧时空滚动拽走对侧。
    if (!changed) return;

    activeSide = side;
    copyScroll(ed, side === 'left' ? el.textB : el.textA,
               side === 'left' ? 'right' : 'left');
  }

  /** 内容变化后按最后操作的一侧重新对齐两侧滚动条 */
  function reconcileScroll() {
    // 内容变了，旧的回声指纹和"上次位置"都失效
    expectedScroll.left = expectedScroll.right = null;

    var src = activeSide === 'left' ? el.textA : el.textB;
    var dst = activeSide === 'left' ? el.textB : el.textA;
    var dstSide = activeSide === 'left' ? 'right' : 'left';
    copyScroll(src, dst, dstSide);

    // 内容变化可能夹紧 scrollTop，把这些位置登记为"已见过"，免得被当成用户滚动
    lastScroll[activeSide] = { top: src.scrollTop, left: src.scrollLeft };
    lastScroll[dstSide] = { top: dst.scrollTop, left: dst.scrollLeft };
    syncLayers('left');
    syncLayers('right');
  }

  /* ---------- 文本写入 ---------- */

  function setText(side, text, msg) {
    // 统一换行符，避免 CRLF / CR 造成行号与统计偏差
    source[side] = String(text || '').replace(/\r\n?/g, '\n');
    // 整侧替换（粘贴按钮 / 导入 / 清空）一律回到未折叠视图：
    // 内容变了旧折叠块就失去意义，只有用户再次点「折叠未改动」才允许折叠。
    foldEnabled = false;
    expandedFolds = Object.create(null);   // 整侧替换后，旧折叠块 id 不再有意义
    // 替换一侧内容后两侧都回到顶部，避免一边在中间、一边在顶部
    el.textA.scrollTop = el.textB.scrollTop = 0;
    el.textA.scrollLeft = el.textB.scrollLeft = 0;
    activeSide = side;
    render();
    if (msg) toast(msg);
  }

  /* ---------- 文件导入 ---------- */

  function countReplacement(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) if (s.charCodeAt(i) === 0xFFFD) n++;
    return n;
  }

  function decodeAndApply(file, side) {
    var reader = new FileReader();
    reader.onload = function () {
      var text = String(reader.result || '').replace(/^\uFEFF/, '');

      // 编码兜底：仅当 GBK 重读后的替换符“明显更少”时才采用它。
      // 原来只要出现任意一个 U+FFFD 就重读，会把 UTF-8 文件里真实的替换符误判成乱码。
      if (text.indexOf('\uFFFD') !== -1) {
        var reader2 = new FileReader();
        reader2.onload = function () {
          var t2 = String(reader2.result || '').replace(/^\uFEFF/, '');
          if (countReplacement(t2) < countReplacement(text)) {
            setText(side, t2, '已导入 ' + file.name + '（GBK 编码）');
          } else {
            setText(side, text, '已导入 ' + file.name + '（部分字符可能乱码）');
          }
        };
        reader2.onerror = function () {
          setText(side, text, '已导入 ' + file.name + '（部分字符可能乱码）');
        };
        try {
          reader2.readAsText(file, 'GBK');
        } catch (e) {
          setText(side, text, '已导入 ' + file.name + '（部分字符可能乱码）');
        }
        return;
      }
      setText(side, text, '已导入 ' + file.name + ' 到' + (side === 'left' ? '左' : '右') + '侧');
    };
    reader.onerror = function () { toast('读取文件失败，请重试'); };
    reader.readAsText(file, 'UTF-8');
  }

  function importFile(side) {
    if (!el.fileInput) return;
    el.fileInput.dataset.side = side;
    el.fileInput.value = '';          // 允许连续导入同一个文件
    el.fileInput.click();
  }

  /* ---------- 剪贴板 ---------- */

  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', 'readonly');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  function copyText(text, okMsg) {
    if (!text) { toast('没有可复制的内容'); return; }
    function ok() { toast(okMsg); }
    function fail() {
      if (legacyCopy(text)) ok();
      else toast('复制失败：请手动选中文本后按 Ctrl+C');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(ok).catch(fail);
    } else {
      fail();
    }
  }

  function pasteInto(side) {
    var ed = side === 'left' ? el.textA : el.textB;
    var label = side === 'left' ? '左侧' : '右侧';

    function apply(text) {
      if (!text) { toast('剪贴板是空的'); return; }
      setText(side, text, '已粘贴到' + label + '（替换原有内容）');
    }

    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(apply).catch(function () {
        if (ed) ed.focus();
        toast('浏览器不允许读取剪贴板，请直接按 Ctrl+V 粘贴到' + label);
      });
    } else {
      if (ed) ed.focus();
      toast('当前浏览器不支持一键读取剪贴板，请按 Ctrl+V 粘贴');
    }
  }

  /* ---------- 按钮行为 ---------- */

  function doSwap() {
    var a = source.left;
    source.left = source.right;
    source.right = a;
    foldEnabled = false;                   // 内容整体变化后回到未折叠视图，必须再次点折叠按钮才折叠
    expandedFolds = Object.create(null);
    el.textA.scrollTop = el.textB.scrollTop = 0;
    el.textA.scrollLeft = el.textB.scrollLeft = 0;
    activeSide = 'left';
    render();
    toast('已交换左右文本');
  }

  function doClear() {
    if (source.left === '' && source.right === '') {
      toast('两侧已经是空的了');
      return;
    }
    if (!window.confirm('确定清空左右两侧的全部文本吗？此操作不可撤销。')) return;
    source.left = source.right = '';
    foldEnabled = false;                   // 清空后不再保留折叠状态
    expandedFolds = Object.create(null);
    el.textA.scrollTop = el.textB.scrollTop = 0;
    el.textA.scrollLeft = el.textB.scrollLeft = 0;
    activeSide = 'left';
    render();
    toast('已清空全部文本');
  }

  /** 只清空一侧，不影响另一侧；复用 setText() 的重置/渲染流程 */
  function doClearSide(side) {
    var label = side === 'left' ? '左侧' : '右侧';
    if (source[side] === '') {
      toast(label + '已经是空的了');
      return;
    }
    if (!window.confirm('确定清空' + label + '的全部文本吗？另一侧不受影响，此操作不可撤销。')) return;
    setText(side, '', '已清空' + label + '文本');
  }

  /* ---------- 输入处理（占位行保护） ---------- */

  /** 找离 lineIdx 最近的真实行 */
  function nearestRealLine(view, lineIdx) {
    var lines = view.split('\n');
    for (var d = 0; d < lines.length; d++) {
      var a = lineIdx + d, b = lineIdx - d;
      if (a >= 0 && a < lines.length && !isProtectedLine(lines[a])) return a;
      if (b >= 0 && b < lines.length && !isProtectedLine(lines[b])) return b;
    }
    return -1;
  }

  function moveCaretToLine(ed, view, lineIdx) {
    var starts = lineStarts(view);
    if (lineIdx < 0 || lineIdx >= starts.length) return;
    try { ed.setSelectionRange(starts[lineIdx], starts[lineIdx]); } catch (e) { /* 忽略 */ }
  }

  /** 阻止在占位行上编辑；跨越占位行的删除也拦下，避免把标记删掉 */
  function onBeforeInput(e) {
    var ed = e.target;
    var view = ed.value;

    // Ctrl+A 全选后粘贴/删除是“替换整侧内容”，不是编辑某一行占位行。
    // 选区末端可能正好落在占位行上，必须放行；占位标记由 viewToSource() 清理。
    if (ed.selectionStart === 0 && ed.selectionEnd === view.length) return;

    var ls = lineIndexAt(view, ed.selectionStart);
    var le = lineIndexAt(view, ed.selectionEnd);
    var kindStart = lineKindAt(view, ls);
    var kindEnd = lineKindAt(view, le);

    if (kindStart || kindEnd) {
      e.preventDefault();
      var badLine = kindStart ? ls : le;
      var target = nearestRealLine(view, badLine);
      if (target >= 0) moveCaretToLine(ed, view, target);
      toast(kindStart === 'fold' || kindEnd === 'fold'
        ? '折叠区域不可编辑，点击「⋯」展开后再修改'
        : '占位行不可编辑，已定位到可编辑行');
      return;
    }

    var starts = lineStarts(view);
    // 在真实行行首按退格：如果上一行是占位行，跳过它而不是删掉分隔换行
    if (e.inputType === 'deleteContentBackward' &&
        ed.selectionStart === ed.selectionEnd && ed.selectionStart === starts[ls] &&
        ls > 0 && isProtectedAt(view, ls - 1)) {
      e.preventDefault();
      var prev = nearestRealLine(view, ls - 1);
      if (prev >= 0) {
        var pos = (prev + 1 < starts.length ? starts[prev + 1] - 1 : view.length);
        try { ed.setSelectionRange(pos, pos); } catch (err) { /* 忽略 */ }
      }
      return;
    }
    // 在真实行行尾按删除：下一行是占位行时同样跳过
    if (e.inputType === 'deleteContentForward' &&
        ed.selectionStart === ed.selectionEnd) {
      var endOfLine = (ls + 1 < starts.length ? starts[ls + 1] - 1 : view.length);
      if (ed.selectionStart === endOfLine && isProtectedAt(view, ls + 1)) {
        e.preventDefault();
        var next = nearestRealLine(view, ls + 1);
        if (next >= 0) moveCaretToLine(ed, view, next);
      }
    }
  }

  /** 上下方向键跨过占位/折叠行；在折叠行按回车直接展开；Tab 插入制表符 */
  function onKeyDown(e) {
    var ed = e.target;
    var view = ed.value;
    var ls = lineIndexAt(view, ed.selectionStart);

    // Tab 在可编辑区域插入真正的制表符，不再把焦点切到下一个按钮；
    // Ctrl/Alt/Meta + Tab 仍交给浏览器（切换标签页/窗口）。
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      var ins = tabInsertion(view, ed.selectionStart, ed.selectionEnd);
      if (!ins) {
        var bad = lineKindAt(view, ls);
        if (bad) {
          var target = nearestRealLine(view, ls);
          if (target >= 0) moveCaretToLine(ed, view, target);
          toast(bad === 'fold'
            ? '折叠区域不可编辑，点击「⋯」展开后再修改'
            : '占位行不可编辑，已定位到可编辑行');
        }
        return;
      }
      var inserted = false;
      try {
        inserted = !!(document.execCommand && document.execCommand('insertText', false, '\t')) && ed.value !== view;
      } catch (err) { inserted = false; }
      if (!inserted) {
        if (typeof ed.setRangeText === 'function') {
          ed.setRangeText('\t', ed.selectionStart, ed.selectionEnd, 'end');
        } else {
          ed.value = ins.text;
          try { ed.setSelectionRange(ins.caret, ins.caret); } catch (err) { /* 忽略 */ }
        }
      }
      // execCommand 通常已经触发 input；这里再调用一次也无副作用（内容未变会早退），
      // 保证 setRangeText 回退路径也能更新 source 并重算统计。
      onInput(ed === el.textA ? 'left' : 'right');
      return;
    }

    if (e.key === 'Enter' && isFoldAt(view, ls)) {
      e.preventDefault();
      var vi = viewInfo[ed === el.textA ? 'left' : 'right'];
      expandFold(vi && vi.foldIds && vi.foldIds[ls]);
      return;
    }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    if (!isProtectedAt(view, ls)) return;
    var lines = view.split('\n');
    var step = e.key === 'ArrowUp' ? -1 : 1;
    for (var i = ls + step; i >= 0 && i < lines.length; i += step) {
      if (!isProtectedLine(lines[i])) {
        e.preventDefault();
        moveCaretToLine(ed, view, i);
        return;
      }
    }
  }

  var measureCanvas = null;

  /** 复用同一个 canvas 量文字宽度，避免鼠标移动时反复创建 */
  function labelWidth(cs, label) {
    if (typeof document.createElement !== 'function') return 0;
    if (!measureCanvas) measureCanvas = document.createElement('canvas');
    var ctx = measureCanvas.getContext && measureCanvas.getContext('2d');
    if (!ctx) return 0;
    ctx.font = cs.font || (cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily);
    return ctx.measureText(label).width;
  }

  /** 把鼠标坐标换算成 textarea 内容区坐标，并算出所在视图行 */
  function foldPointInfo(ed, e) {
    if (!e || typeof e.clientX !== 'number' || typeof e.clientY !== 'number') return null;
    var rect = ed.getBoundingClientRect && ed.getBoundingClientRect();
    if (!rect || typeof window.getComputedStyle !== 'function') return null;
    var cs = window.getComputedStyle(ed);
    return {
      x: e.clientX - rect.left - (parseFloat(cs.paddingLeft) || 0) + (ed.scrollLeft || 0),
      y: e.clientY - rect.top - (parseFloat(cs.paddingTop) || 0) + (ed.scrollTop || 0),
      lineHeight: parseFloat(cs.lineHeight) || 20,
      cs: cs
    };
  }

  /**
   * 鼠标是否落在折叠行的「未改动 N 行（点击展开）」文字上。
   * 不传 lineIdx 时按鼠标 y 自动算所在行，供 mousemove 悬停使用。
   */
  function foldHitByPoint(ed, e, lineIdx) {
    var p = foldPointInfo(ed, e);
    if (!p || p.y < 0) return false;
    var idx = typeof lineIdx === 'number' ? lineIdx : Math.floor(p.y / p.lineHeight);
    var vi = viewInfo[ed === el.textA ? 'left' : 'right'];
    var vl = vi && vi.viewLines && vi.viewLines[idx];
    if (!vl || !vl.fold) return false;
    return foldLabelHit(p.x, p.y, labelWidth(p.cs, vl.text), p.lineHeight, idx);
  }

  function isFoldLabelClicked(ed, e, view, lineIdx) {
    return foldHitByPoint(ed, e, lineIdx);
  }

  /** 悬停到折叠文字时切换手势光标，并给背景层/行号栏对应行加高亮 */
  function updateFoldHover(ed, e) {
    var hit = foldHitByPoint(ed, e);
    ed.style.cursor = hit ? 'pointer' : '';
    var p = foldPointInfo(ed, e);
    var idx = p ? Math.floor(p.y / p.lineHeight) : -1;
    var side = ed === el.textA ? 'left' : 'right';
    var nodes = [
      side === 'left' ? el.backdropInnerLeft : el.backdropInnerRight,
      side === 'left' ? el.gutterInnerLeft : el.gutterInnerRight
    ];
    for (var n = 0; n < nodes.length; n++) {
      var node = nodes[n];
      if (!node) continue;
      for (var i = 0; i < node.children.length; i++) {
        if (node.children[i].classList) node.children[i].classList.toggle('is-hover', hit && i === idx);
      }
    }
  }

  /** 离开编辑区时还原默认光标并清掉悬停高亮 */
  function clearFoldHover(ed) {
    ed.style.cursor = '';
    var side = ed === el.textA ? 'left' : 'right';
    [side === 'left' ? el.backdropInnerLeft : el.backdropInnerRight,
     side === 'left' ? el.gutterInnerLeft : el.gutterInnerRight].forEach(function (node) {
      if (!node) return;
      for (var i = 0; i < node.children.length; i++) {
        if (node.children[i].classList) node.children[i].classList.remove('is-hover');
      }
    });
  }

  /** 单击占位行时把光标移到最近的真实行，这样点任意位置后都能直接粘贴 */
  function onClick(e) {
    var ed = e.target;
    if (ed.selectionStart !== ed.selectionEnd) return;   // 拖选文字时不干预
    var view = ed.value;
    var ls = lineIndexAt(view, ed.selectionStart);
    if (isFoldAt(view, ls)) {
      // 只有真的点在「未改动（点击展开）」文字上才展开；点这一行右侧空白不展开。
      if (!isFoldLabelClicked(ed, e, view, ls)) return;
      var vi = viewInfo[ed === el.textA ? 'left' : 'right'];
      expandFold(vi && vi.foldIds && vi.foldIds[ls]);
      return;
    }
    if (!isPlaceholderAt(view, ls)) return;
    var target = nearestRealLine(view, ls);
    if (target >= 0) moveCaretToLine(ed, view, target);
  }

  /** 用户手动复制时，把选区里的占位标记去掉（边界落在占位行内部时也整行吞掉） */
  function onCopy(e) {
    var ed = e.target;
    var view = ed.value;
    var ss = ed.selectionStart, se = ed.selectionEnd;
    if (ss === se) return;

    var starts = lineStarts(view);
    var firstLine = lineIndexAt(view, ss);
    var lastLine = lineIndexAt(view, se);

    // 选区边界落在占位/折叠行内部时，扩展到整行，保证标记被完整移除
    if (isProtectedAt(view, firstLine)) ss = starts[firstLine];
    if (isProtectedAt(view, lastLine) && se > starts[lastLine]) {
      se = lastLine + 1 < starts.length ? starts[lastLine + 1] : view.length;
    }

    var text = view.substring(ss, se);
    if (text.indexOf('\u200B') === -1) return;
    if (e.clipboardData) {
      e.clipboardData.setData('text/plain', viewToSource(text));
      e.preventDefault();
    }
  }

  function onInput(side, e) {
    if (composing[side] || (e && e.isComposing)) return;   // 本侧输入法组词中不重写
    var ed = side === 'left' ? el.textA : el.textB;
    var view = ed.value;
    var vi = viewInfo[side];
    var newSource = viewToSourceForInput(view, vi && vi.foldHidden);
    if (newSource === source[side]) return;

    pendingCaret[side] = {
      start: caretViewToSource(view, ed.selectionStart, vi && vi.phSet, vi && vi.foldHidden),
      end: caretViewToSource(view, ed.selectionEnd, vi && vi.phSet, vi && vi.foldHidden)
    };
    source[side] = newSource;
    activeSide = side;
    scheduleRender();
  }

  /* ---------- 事件绑定 ---------- */

  function bindEvents() {
    // 输入即算（防抖 150ms）；占位行由 beforeinput / keydown 保护
    [['left', el.textA], ['right', el.textB]].forEach(function (pair) {
      var side = pair[0], ed = pair[1];
      ed.addEventListener('input', function (e) { onInput(side, e); });
      ed.addEventListener('beforeinput', onBeforeInput);
      ed.addEventListener('keydown', onKeyDown);
      ed.addEventListener('click', onClick);
      ed.addEventListener('mousemove', function (e) { updateFoldHover(ed, e); });
      ed.addEventListener('mouseleave', function () { clearFoldHover(ed); });
      ed.addEventListener('copy', onCopy);
      ed.addEventListener('compositionstart', function () { composing[side] = true; });
      ed.addEventListener('compositionend', function () {
        composing[side] = false;
        onInput(side);
      });
    });

    // 行号栏点击折叠块 / 迷你条点击跳差异
    [['left', el.gutterLeft, el.mapLeft], ['right', el.gutterRight, el.mapRight]].forEach(function (t) {
      var side = t[0], gutter = t[1], map = t[2];
      if (gutter) {
        gutter.addEventListener('click', function (e) {
          var node = e.target;
          while (node && node !== gutter && node.className.indexOf('gutter-line') === -1) node = node.parentNode;
          if (!node || node === gutter) return;
          var idx = Array.prototype.indexOf.call(gutter.firstChild ? gutter.firstChild.children : [], node);
          var vi = viewInfo[side];
          if (idx >= 0 && vi && vi.foldIds && vi.foldIds[idx]) expandFold(vi.foldIds[idx]);
        });
      }
      if (map) {
        map.addEventListener('click', function (e) {
          var m = editorMetrics();
          var ed = side === 'left' ? el.textA : el.textB;
          var rect = map.getBoundingClientRect();
          var line = Math.floor((e.clientY - rect.top + ed.scrollTop - m.padTop) / m.lineHeight);
          jumpToNearbyDiff(Math.max(0, line));
        });
      }
    });

    // 全局快捷键：F7 上一个差异，F8 下一个差异
    document.addEventListener('keydown', function (e) {
      if (e.key === 'F7') { e.preventDefault(); gotoDiff(-1); }
      else if (e.key === 'F8') { e.preventDefault(); gotoDiff(1); }
    });

    // 滚动同步
    el.textA.addEventListener('scroll', function () { onEditorScroll('left'); });
    el.textB.addEventListener('scroll', function () { onEditorScroll('right'); });

    // 拖拽文件到编辑框直接导入
    [['left', el.textA], ['right', el.textB]].forEach(function (pair) {
      var side = pair[0], node = pair[1];
      node.addEventListener('dragover', function (e) { e.preventDefault(); });
      node.addEventListener('drop', function (e) {
        var files = e.dataTransfer && e.dataTransfer.files;
        if (!files || !files.length) return;
        e.preventDefault();
        decodeAndApply(files[0], side);
      });
    });

    // 工具栏
    $('btnImportLeft').addEventListener('click', function () { importFile('left'); });
    $('btnImportRight').addEventListener('click', function () { importFile('right'); });
    $('btnPasteLeft').addEventListener('click', function () { pasteInto('left'); });
    $('btnPasteRight').addEventListener('click', function () { pasteInto('right'); });
    $('btnSwap').addEventListener('click', doSwap);
    $('btnClear').addEventListener('click', doClear);
    $('btnClearLeft').addEventListener('click', function () { doClearSide('left'); });
    $('btnClearRight').addEventListener('click', function () { doClearSide('right'); });
    $('btnFold').addEventListener('click', toggleFold);
    $('btnPrevDiff').addEventListener('click', function () { gotoDiff(-1); });
    $('btnNextDiff').addEventListener('click', function () { gotoDiff(1); });

    $('btnCopyResult').addEventListener('click', function () {
      if (source.left === '' && source.right === '') {
        toast('两侧都没有内容，无法生成对比结果');
        return;
      }
      if (!dmp) {
        toast('差异算法库未能加载，无法生成对比结果');
        return;
      }
      copyText(buildReport(dmp, source.left, source.right), '已复制对比结果到剪贴板');
    });
    $('btnCopyLeft').addEventListener('click', function () {
      copyText(source.left, '已复制左侧文本');
    });
    $('btnCopyRight').addEventListener('click', function () {
      copyText(source.right, '已复制右侧文本');
    });
  }

  /* ---------- 初始化 ---------- */

  function init() {
    el.textA = $('textA');
    el.textB = $('textB');
    el.backdropInnerLeft = $('backdropInnerLeft');
    el.backdropInnerRight = $('backdropInnerRight');
    el.gutterLeft = $('gutterLeft');
    el.gutterRight = $('gutterRight');
    el.gutterInnerLeft = $('gutterInnerLeft');
    el.gutterInnerRight = $('gutterInnerRight');
    el.mapLeft = $('mapLeft');
    el.mapRight = $('mapRight');
    el.countLeft = $('countLeft');
    el.countRight = $('countRight');
    el.statAdd = $('statAdd');
    el.statDel = $('statDel');
    el.statEq = $('statEq');
    el.diffCur = $('diffCur');
    el.diffTotal = $('diffTotal');
    el.btnFold = $('btnFold');
    el.btnPrevDiff = $('btnPrevDiff');
    el.btnNextDiff = $('btnNextDiff');
    el.banner = $('banner');
    el.toast = $('toast');

    if (typeof diff_match_patch !== 'undefined') {
      dmp = new diff_match_patch();
      dmp.Diff_Timeout = 1.0;   // 超大文本时最多算 1 秒，避免卡死
    } else {
      showBanner('差异算法库 diff-match-patch 未能加载：请联网后刷新，或把 vendor/diff-match-patch.js 放到本目录。当前仍可编辑文本，但没有高亮与统计。');
    }

    // index.html 里预置的示例文本就是真实文本的初始值
    source.left = el.textA.value;
    source.right = el.textB.value;

    bindEvents();

    // 复用一个隐藏的 file input（比每次点击都新建更稳定，也不会在页面里留下垃圾节点）
    el.fileInput = document.createElement('input');
    el.fileInput.type = 'file';
    el.fileInput.accept = '.txt,.text,.log,.md,.csv,text/plain';
    el.fileInput.style.position = 'fixed';
    el.fileInput.style.left = '-9999px';
    el.fileInput.addEventListener('change', function () {
      var file = el.fileInput.files && el.fileInput.files[0];
      if (file) decodeAndApply(file, el.fileInput.dataset.side === 'right' ? 'right' : 'left');
    });
    document.body.appendChild(el.fileInput);

    render();
  }

  /* ---------- 对外暴露（调试 / 自动化测试用） ---------- */
  if (typeof window !== 'undefined') {
    window.PlainDiff = {
      esc: esc,
      countLines: countLines,
      buildSide: buildSide,
      plainSide: plainSide,
      lineDiffs: lineDiffs,
      statsFromLineDiffs: statsFromLineDiffs,
      lineLevelFlags: lineLevelFlags,
      insertionPoints: insertionPoints,
      PH: PH,
      FOLD: FOLD,
      FOLD_CONTEXT: FOLD_CONTEXT,
      isPlaceholderLine: isPlaceholderLine,
      isFoldLine: isFoldLine,
      isProtectedLine: isProtectedLine,
      foldLabel: foldLabel,
      foldLabelHit: foldLabelHit,
      tabInsertion: tabInsertion,
      foldRows: foldRows,
      changedRowIndices: changedRowIndices,
      groupDiffBlocks: groupDiffBlocks,
      isTailRow: isTailRow,
      hasFoldLines: hasFoldLines,
      sourceLineCount: sourceLineCount,
      alignRows: alignRows,
      buildViewLines: buildViewLines,
      viewLinesToText: viewLinesToText,
      viewToSource: viewToSource,
      viewToSourceForInput: viewToSourceForInput,
      caretViewToSource: caretViewToSource,
      caretSourceToView: caretSourceToView,
      buildDetailRows: buildDetailRows,
      computeStats: computeStats,
      buildReport: buildReport,
      render: render
    };
  }

  /* ---------- 启动 ---------- */
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }
})();
