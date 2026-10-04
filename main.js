// ==PREPROCESSOR==
// @name "Apple Music Style Lyrics"
// @author "lyrics"
// @version "1.5"
// ==/PREPROCESSOR==

/**
 * Apple Music style lyrics for foobar2000 (JScript Panel 3.x, Direct2D/DirectWrite).
 *
 * Host Component: foo_jscript_panel3 (v3.4+ by marc2003)
 * Rendering: Hardware-accelerated Direct2D / DirectWrite
 * Engine: ES5 / JScript9
 *
 * Background Modes:
 *   - Blurred Cover Image (from external image files or embedded tags in .flac/.mp3/.m4a)
 *   - Animated Gradient Mesh (Apple Music style dynamic aurora blobs from track palette)
 *   Controls: Right-click context menu or press 'B' key to switch background mode.
 *
 * Lyrics Modes (auto-detected per track, best source wins):
 *   WORD  - Enhanced LRC with <mm:ss.xx> syllable tags  -> sweep fill per syllable
 *   LINE  - Plain LRC with [mm:ss.xx] stamps             -> whole line highlight
 *   PLAIN - Unsynced text                                -> static text, manual scroll
 *   NONE  - nothing found
 */
'use strict';

// Configuration & constants
var DWRITE_FONT_WEIGHT_NORMAL = 400;
var DWRITE_FONT_WEIGHT_BOLD = 700;
var DWRITE_TEXT_ALIGNMENT_LEADING = 0;
var DWRITE_TEXT_ALIGNMENT_TRAILING = 1;
var DWRITE_TEXT_ALIGNMENT_CENTER = 2;
var DWRITE_PARAGRAPH_ALIGNMENT_NEAR = 0;
var DWRITE_PARAGRAPH_ALIGNMENT_CENTER = 2;
var DWRITE_WORD_WRAPPING_WRAP = 0;
var DWRITE_WORD_WRAPPING_NO_WRAP = 1;

var IDC_ARROW = 32512;
var IDC_HAND = 32649;

var CFG = {
	fontFallback: ['SF Pro Rounded', 'SF Pro', 'SF Pro Display', 'SF Pro Text', 'Inter', 'Segoe UI', 'Arial'],
	fontFamily: '',                       // user-chosen installed font ('' = automatic fallback list)
	fontScale: 1,                         // user text size multiplier (menu: 85% .. 130%)
	rightAlignBacking: true,              // align standalone parenthetical backing lyrics "(...)" to the right
	readCodePages: [65001, 0],            // lyric files: UTF-8 first, then ANSI

	activeSize: 24, activeBold: true,     // pt
	otherSize: 18, otherBold: false,      // pt
	subActiveSize: 15, subActiveBold: false, // pt for active romanized/sub lyric
	subOtherSize: 13, subOtherBold: false,  // pt for inactive romanized/sub lyric
	subGap: 4,                            // px gap between primary line and romanized line
	activeWordScale: 1.08,                // size multiplier for currently playing word ("big")
	activeWordLift: 3,                    // px lift for currently playing word
	wordTransition: { enterMaxMs: 300, settleMs: 350 }, // smooth entry & landing transitions (ms)
	baseWidth: 520,                       // panel width that maps to scale 1
	scaleMin: 0.8, scaleMax: 1.8,

	lineGap: 16,                          // px (scaled) between lines
	gapHeight: 44,                        // height of an instrumental dots line
	blankHeight: 14,                      // blank line in PLAIN mode
	padXRatio: 0.07, padXMin: 20, padXMax: 64,
	focusRatio: 0.38,                     // active line centre, fraction of panel height
	plainTop: 28,                         // PLAIN mode top padding (scaled)

	spring: { k: 130, c: 19, step: 1 / 120, restPos: 0.15, restVel: 0.6, stagger: 35, staggerMax: 8 },
	alphaRate: 9,                         // 1/s, exponential approach for line alpha
	alpha: { active: 1.0, near: 0x88 / 255, far: 0x33 / 255, inactiveWord: 0.38, plain: 0.85 },
	edgeFade: 0.12,                       // fraction of panel height used for fade at top/bottom
	liftPx: 2,
	glow: true,

	timing: {
		lastWordMax: 1.5,                 // s, max duration of the final syllable without explicit end
		gapMinSec: 3,                     // instrumental gap lines shorter than this are dropped
		lookahead: 0,                     // s added to playback time
		estimateWordTiming: false         // LINE mode: sweep words proportionally to length
	},

	wheelPx: 70,
	resumeMs: 3000,
	dragThreshold: 4,

	tick: { hotMs: 16, pollMs: 100 },
	retry: { everyMs: 2500, max: 8 },

	cachePatterns: ['{artist} - {title}', '{artist}\\{title}'],

	bg: {
		mode: 0,                          // 0 = Blurred Cover Image, 1 = Animated Gradient Mesh
		scaleDiv: 4,                      // thumbnail divisor for fast blur
		blurRadius: 18,                   // blur radius applied to cover image
		tint: 0.48,                       // dark overlay tint (0 = bright, 1 = solid black)
		gradientTint: 0.35,               // dark overlay tint for gradient mode
		minSize: 24, fps: 10, blobs: 4,
		blurDiv: 10, mixSeconds: 0.9,
		slateTop: [0x12, 0x12, 0x16], slateBottom: [0x1c, 0x1c, 0x24],
		base: [16, 16, 20],
		defaultColors: [[48, 48, 78], [70, 44, 86], [38, 66, 92], [60, 50, 70]]
	}
};

var MODE = { NONE: 0, PLAIN: 1, LINE: 2, WORD: 3 };
var BG_MODE = { COVER: 0, GRADIENT: 1 };

var CJK_RE = /[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/;
var TOKEN_RE = /[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]\s*|[^\s\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]+\s*/g;
var CJK_NO_START = /[、。，．・：；？！）〕］｝〉》」』】”’ーヽヾゝゞ々ァィゥェォッャュョヮヵヶぁぃぅぇぉっゃゅょゎ\?!;:,.\)\]\}]/;
var CJK_NO_END = /[（〔［｛〈《「『【“‘\(\[\{<]/;

// Helpers
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t) { return a + (b - a) * t; }
function easeOut(t) { return 1 - (1 - t) * (1 - t) * (1 - t); }

function RGB(r, g, b) {
	return (0xff000000 | (clamp(Math.round(r), 0, 255) << 16) | (clamp(Math.round(g), 0, 255) << 8) | clamp(Math.round(b), 0, 255)) | 0;
}

function RGBA(r, g, b, a) {
	return ((clamp(Math.round(a), 0, 255) << 24) | (clamp(Math.round(r), 0, 255) << 16) | (clamp(Math.round(g), 0, 255) << 8) | clamp(Math.round(b), 0, 255)) | 0;
}

function white(a) { return RGBA(255, 255, 255, a * 255); }

function blendColours(c1, c2, factor) {
	var a1 = (c1 >> 24) & 255, r1 = (c1 >> 16) & 255, g1 = (c1 >> 8) & 255, b1 = c1 & 255;
	var a2 = (c2 >> 24) & 255, r2 = (c2 >> 16) & 255, g2 = (c2 >> 8) & 255, b2 = c2 & 255;
	var a = Math.round(a1 + factor * (a2 - a1));
	var r = Math.round(r1 + factor * (r2 - r1));
	var g = Math.round(g1 + factor * (g2 - g1));
	var b = Math.round(b1 + factor * (b2 - b1));
	return RGBA(r, g, b, a);
}

function has(o, name) {
	if (!o) return false;
	try {
		return typeof o[name] !== 'undefined';
	} catch (e) {
		return false;
	}
}

function scaleDpi(pt) {
	var dpi = (typeof window !== 'undefined' && window.DPI) ? window.DPI : 96;
	return Math.max(1, Math.round(pt * dpi / 72));
}

function rgbToHsl(r, g, b) {
	r /= 255; g /= 255; b /= 255;
	var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
	var h = 0, s = 0, l = (mx + mn) / 2;
	if (mx !== mn) {
		var d = mx - mn;
		s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
		if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
		else if (mx === g) h = (b - r) / d + 2;
		else h = (r - g) / d + 4;
		h /= 6;
	}
	return [h, s, l];
}

function hslToRgb(h, s, l) {
	if (s === 0) { var v = l * 255; return [v, v, v]; }
	var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
	var p = 2 * l - q;
	function f(t) {
		if (t < 0) t += 1;
		if (t > 1) t -= 1;
		if (t < 1 / 6) return p + (q - p) * 6 * t;
		if (t < 1 / 2) return q;
		if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
		return p;
	}
	return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

/** Boost saturation / clamp lightness so album colours look vibrant but not blinding. */
function vibrant(c) {
	var hsl = rgbToHsl((c >> 16) & 255, (c >> 8) & 255, c & 255);
	return hslToRgb(hsl[0], clamp(Math.max(hsl[1], 0.45), 0, 0.9), clamp(hsl[2], 0.3, 0.55));
}

function mixRgb(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }

function hashString(s) {
	var h = 5381;
	for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
	return Math.abs(h);
}

function sanitizeName(s) { return String(s || '').replace(/[\\\/:*?"<>|]/g, '_').replace(/^\s+|\s+$/g, ''); }

// Typography & measurement
var S = {
	mode: MODE.NONE, lines: [], active: -1,
	scrollPos: 0, totalH: 0, focusY: 0, padX: 0, scale: 1, W: 0, H: 0,
	playing: false, paused: false,
	manual: false, lastUser: 0, drag: null,
	timer: 0, timerMs: 0, lastTick: 0, acc: 0,
	track: null, tries: 0, nextRetry: 0, hotWord: false, hand: false
};

function fontExists(name) {
	if (!name) return false;
	try {
		if (has(utils, 'CheckFont') && utils.CheckFont(name)) return true;
	} catch (e) { /* fall through */ }
	try {
		var list = listInstalledFonts();
		var lower = name.toLowerCase();
		for (var i = 0; i < list.length; i++) {
			if (list[i].toLowerCase() === lower) return true;
		}
	} catch (e2) {}
	return name === 'Segoe UI' || name === 'Arial';
}

function resolveFontName(name) {
	if (!name) return '';
	try {
		var list = listInstalledFonts();
		var lower = name.toLowerCase().replace(/[\-_]/g, ' ').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
		for (var i = 0; i < list.length; i++) {
			var itemLower = list[i].toLowerCase().replace(/[\-_]/g, ' ').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
			if (itemLower === lower) return list[i];
		}
	} catch (e) {}
	return name;
}

var Fonts = {
	face: null,
	names: CFG.fontFallback,
	obj: [null, null, null], // [0] = other/inactive, [1] = active line, [2] = currently playing word
	str: ['', '', ''],       // JSON strings for gr.WriteText
	sizePx: [0, 0, 0],
	weight: [DWRITE_FONT_WEIGHT_NORMAL, DWRITE_FONT_WEIGHT_BOLD, DWRITE_FONT_WEIGHT_BOLD],
	rowH: [0, 0, 0],
	spaceW: [0, 0, 0],
	subObj: [null, null],    // [0] = other/inactive sub, [1] = active sub
	subStr: ['', ''],        // JSON strings for sub WriteText
	subSizePx: [0, 0],
	subWeight: [DWRITE_FONT_WEIGHT_NORMAL, DWRITE_FONT_WEIGHT_NORMAL],
	subRowH: [0, 0],
	subSpaceW: [0, 0],

	pickFace: function () {
		if (CFG.fontFamily && fontExists(CFG.fontFamily)) return CFG.fontFamily;
		for (var i = 0; i < this.names.length; i++) {
			if (fontExists(this.names[i])) return this.names[i];
		}
		return 'Segoe UI';
	},

	build: function (scale) {
		if (!this.face) this.face = this.pickFace();
		S.scale = scale;
		var fs = CFG.fontScale || 1;
		this.sizePx[0] = scaleDpi(CFG.otherSize * fs * scale);
		this.sizePx[1] = scaleDpi(CFG.activeSize * fs * scale);
		this.sizePx[2] = scaleDpi(CFG.activeSize * fs * (CFG.activeWordScale || 1.10) * scale);
		this.weight[0] = CFG.otherBold ? DWRITE_FONT_WEIGHT_BOLD : DWRITE_FONT_WEIGHT_NORMAL;
		this.weight[1] = CFG.activeBold ? DWRITE_FONT_WEIGHT_BOLD : DWRITE_FONT_WEIGHT_NORMAL;
		this.weight[2] = DWRITE_FONT_WEIGHT_BOLD;

		for (var v = 0; v < 3; v++) {
			this.obj[v] = {
				Name: this.face,
				Size: this.sizePx[v],
				Weight: this.weight[v]
			};
			this.str[v] = JSON.stringify(this.obj[v]);

			// Measure single row height using CreateTextLayout if available, or fallback
			var rh = 0;
			try {
				if (has(utils, 'CreateTextLayout')) {
					var tl = utils.CreateTextLayout('Ag', this.face, this.sizePx[v], this.weight[v]);
					if (tl && has(tl, 'CalcTextHeight')) rh = tl.CalcTextHeight(10000);
				}
			} catch (e) { rh = 0; }
			this.rowH[v] = rh > 0 ? Math.ceil(rh * 1.25) : Math.ceil(this.sizePx[v] * 1.35);

			// Measure single space width
			var sp = 0;
			try {
				if (has(utils, 'CalcTextWidth')) {
					var w1 = utils.CalcTextWidth('a a', this.face, this.sizePx[v], this.weight[v]);
					var w2 = utils.CalcTextWidth('aa', this.face, this.sizePx[v], this.weight[v]);
					sp = w1 - w2;
				}
			} catch (e) { sp = 0; }
			this.spaceW[v] = sp > 0 ? sp : Math.ceil(this.sizePx[v] * 0.28);
		}

		this.subSizePx[0] = scaleDpi((CFG.subOtherSize || 13) * fs * scale);
		this.subSizePx[1] = scaleDpi((CFG.subActiveSize || 15) * fs * scale);
		this.subWeight[0] = CFG.subOtherBold ? DWRITE_FONT_WEIGHT_BOLD : DWRITE_FONT_WEIGHT_NORMAL;
		this.subWeight[1] = CFG.subActiveBold ? DWRITE_FONT_WEIGHT_BOLD : DWRITE_FONT_WEIGHT_NORMAL;

		for (var sv = 0; sv < 2; sv++) {
			this.subObj[sv] = {
				Name: this.face,
				Size: this.subSizePx[sv],
				Weight: this.subWeight[sv]
			};
			this.subStr[sv] = JSON.stringify(this.subObj[sv]);

			var srh = 0;
			try {
				if (has(utils, 'CreateTextLayout')) {
					var stl = utils.CreateTextLayout('Ag', this.face, this.subSizePx[sv], this.subWeight[sv]);
					if (stl && has(stl, 'CalcTextHeight')) srh = stl.CalcTextHeight(10000);
				}
			} catch (e) { srh = 0; }
			this.subRowH[sv] = srh > 0 ? Math.ceil(srh * 1.25) : Math.ceil(this.subSizePx[sv] * 1.35);

			var ssp = 0;
			try {
				if (has(utils, 'CalcTextWidth')) {
					var sw1 = utils.CalcTextWidth('a a', this.face, this.subSizePx[sv], this.subWeight[sv]);
					var sw2 = utils.CalcTextWidth('aa', this.face, this.subSizePx[sv], this.subWeight[sv]);
					ssp = sw1 - sw2;
				}
			} catch (e) { ssp = 0; }
			this.subSpaceW[sv] = ssp > 0 ? ssp : Math.ceil(this.subSizePx[sv] * 0.28);
		}
	},

	measureWidth: function (text, v) {
		if (!text) return 0;
		try {
			if (has(utils, 'CalcTextWidth')) {
				return utils.CalcTextWidth(text, this.face, this.sizePx[v], this.weight[v]);
			}
		} catch (e) {}
		return Math.ceil(text.length * this.sizePx[v] * 0.55);
	},

	measureSubWidth: function (text, v) {
		if (!text) return 0;
		try {
			if (has(utils, 'CalcTextWidth')) {
				return utils.CalcTextWidth(text, this.face, this.subSizePx[v], this.subWeight[v]);
			}
		} catch (e) {}
		return Math.ceil(text.length * this.subSizePx[v] * 0.55);
	}
};

// Parser
function tsToSec(mm, ss, frac) {
	return parseInt(mm, 10) * 60 + parseInt(ss, 10) + (frac ? parseInt(frac, 10) / Math.pow(10, frac.length) : 0);
}

function mkWord(text, s, e) {
	return {
		text: text, vis: text.replace(/\s+$/, '').length, startTime: s, endTime: e,
		w: [0, 0], x: [0, 0], row: [0, 0]
	};
}

function isStandaloneParentheses(text) {
	if (!text) return false;
	var s = String(text).replace(/^\s+|\s+$/g, '');
	// Strip optional outer quotes e.g. "(text)", "('text')", etc.
	s = s.replace(/^["'\u201c\u2018\u300c]+|["'\u201d\u2019\u300d]+$/g, '').replace(/^\s+|\s+$/g, '');
	return /^[\(\uff08].*[\)\uff09][\.\?!,\u2026]*$/.test(s);
}

function mkLine(start, isGap) {
	return {
		startTime: start, endTime: start, text: '', isGap: !!isGap, blank: false, timed: false,
		alignRight: false,
		words: [], rows: [[], []], sub: [], subRows: [[], []], h: [0, 0], trailEnd: null,
		y: 0, v: 0, tgt: 0, pend: 0, tgtAt: 0, a: 0, aT: 0, docY: 0
	};
}

function tokenize(text) {
	return text.match(TOKEN_RE) || [];
}

function parseBody(body, shift) {
	var re = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;
	var raw = [];
	var last = 0, cur = null, tags = 0, m;
	while ((m = re.exec(body))) {
		var chunk = body.slice(last, m.index);
		if (chunk) raw.push({ t: cur, text: chunk });
		cur = tsToSec(m[1], m[2], m[3]) + shift;
		tags++;
		last = re.lastIndex;
	}
	var rest = body.slice(last);
	var trailEnd = null;
	if (rest) raw.push({ t: cur, text: rest });
	else if (cur !== null) trailEnd = cur;

	var segs = [];
	for (var i = 0; i < raw.length; i++) {
		var txt = raw[i].text;
		var lead = /^\s+/.exec(txt);
		if (lead) {
			txt = txt.slice(lead[0].length);
			if (segs.length) segs[segs.length - 1].text += lead[0];
		}
		if (txt) segs.push({ t: raw[i].t, text: txt });
	}
	if (segs.length) segs[segs.length - 1].text = segs[segs.length - 1].text.replace(/\s+$/, '');
	return { segs: segs, trailEnd: trailEnd, tags: tags };
}

function parsePlain(rows) {
	var lines = [];
	for (var i = 0; i < rows.length; i++) {
		var text = rows[i].replace(/^\s+|\s+$/g, '');
		if (!text) {
			if (lines.length && !lines[lines.length - 1].blank) {
				var b = mkLine(0, false);
				b.blank = true;
				lines.push(b);
			}
			continue;
		}
		var L = mkLine(0, false);
		L.text = text;
		L.alignRight = isStandaloneParentheses(text);
		L.words = tokenize(text).map(function (t) { return mkWord(t, 0, 0); });
		lines.push(L);
	}
	while (lines.length && lines[lines.length - 1].blank) lines.pop();
	return lines.length ? { mode: MODE.PLAIN, lines: lines } : { mode: MODE.NONE, lines: [] };
}

function parseLyrics(raw) {
	var src = String(raw || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
	if (!src.replace(/\s+/g, '')) return { mode: MODE.NONE, lines: [] };

	var lineRe = /^\s*((?:\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]\s*)+)(.*)$/;
	var metaRe = /^\s*\[([A-Za-z#]+):([^\]]*)\]\s*$/;
	var stampRe = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

	var offset = 0, totalTags = 0;
	var entries = [], plainRows = [];

	src.split('\n').forEach(function (row, idx) {
		var lm = lineRe.exec(row);
		if (lm) {
			var times = [], sm;
			stampRe.lastIndex = 0;
			while ((sm = stampRe.exec(lm[1]))) times.push(tsToSec(sm[1], sm[2], sm[3]));
			times.forEach(function (t) {
				entries.push({ start: t, body: lm[2], shift: t - times[0], idx: idx });
			});
			return;
		}
		var mm = metaRe.exec(row);
		if (mm) {
			if (mm[1].toLowerCase() === 'offset') offset = (parseInt(mm[2], 10) || 0) / 1000;
			return;
		}
		plainRows.push(row);
	});

	if (!entries.length) return parsePlain(plainRows);

	entries.sort(function (a, b) { return (a.start - b.start) || (a.idx - b.idx); });
	var lines = [];
	for (var n = 0; n < entries.length; n++) {
		var e = entries[n];
		var start = Math.max(0, e.start - offset);
		var bare = e.body.replace(/<[^>]*>/g, '').replace(/^\s+|\s+$/g, '');
		var L = mkLine(start, bare === '');
		if (!L.isGap) {
			var pb = parseBody(e.body, e.shift - offset);
			if (pb.tags > 0 && pb.segs.length) {
				var prevT = start;
				L.words = pb.segs.map(function (s) {
					var t = s.t === null ? start : Math.max(s.t, prevT);
					prevT = t;
					return mkWord(s.text, t, t);
				});
				L.timed = true;
				L.trailEnd = pb.trailEnd;
				totalTags += pb.tags;
			} else {
				L.words = tokenize(bare).map(function (t) { return mkWord(t, start, start); });
			}
			L.text = L.words.map(function (w) { return w.text; }).join('');
			L.alignRight = isStandaloneParentheses(L.text || bare);

			// Pair any subsequent entries that share the exact same timestamp (e.g. romanized / translations)
			while (n + 1 < entries.length && Math.abs(entries[n + 1].start - e.start) < 0.005) {
				var nextBare = entries[n + 1].body.replace(/<[^>]*>/g, '').replace(/^\s+|\s+$/g, '');
				if (nextBare && nextBare !== bare) {
					L.sub.push(nextBare);
				}
				n++;
			}
		} else {
			while (n + 1 < entries.length && Math.abs(entries[n + 1].start - e.start) < 0.005) {
				n++;
			}
		}
		lines.push(L);
	}

	var len = (typeof fb !== 'undefined' && fb.PlaybackLength) ? fb.PlaybackLength : 0;
	var i, j;
	for (i = 0; i < lines.length; i++) {
		var end = null;
		for (j = i + 1; j < lines.length; j++) {
			if (lines[j].startTime > lines[i].startTime + 0.001) { end = lines[j].startTime; break; }
		}
		lines[i].endTime = end !== null ? end : (len > lines[i].startTime ? len : lines[i].startTime + 5);
	}

	for (i = 0; i < lines.length; i++) {
		var Ln = lines[i], ws = Ln.words;
		if (!ws.length) continue;
		if (Ln.timed) {
			for (j = 0; j < ws.length; j++) {
				if (j + 1 < ws.length) ws[j].endTime = Math.max(ws[j + 1].startTime, ws[j].startTime + 0.001);
				else {
					var ee = Ln.trailEnd !== null ? Ln.trailEnd : Math.min(Ln.endTime, ws[j].startTime + CFG.timing.lastWordMax);
					ws[j].endTime = Math.max(ee, ws[j].startTime + 0.05);
				}
			}

			Ln.words = ws;
			Ln.text = Ln.words.map(function (w) { return w.text; }).join('');
			Ln.alignRight = isStandaloneParentheses(Ln.text);
		} else if (CFG.timing.estimateWordTiming && ws.length > 1) {
			var dur = (Ln.endTime - Ln.startTime) * 0.9;
			var total = 0;
			for (j = 0; j < ws.length; j++) total += Math.max(1, ws[j].vis);
			var t0 = Ln.startTime;
			for (j = 0; j < ws.length; j++) {
				var d = dur * Math.max(1, ws[j].vis) / total;
				ws[j].startTime = t0; ws[j].endTime = t0 + d; t0 += d;
			}
			Ln.timed = true;
		} else {
			for (j = 0; j < ws.length; j++) { ws[j].startTime = Ln.startTime; ws[j].endTime = Ln.endTime; }
		}
	}

	var kept = lines.filter(function (Lk, k) {
		return !Lk.isGap || (k < lines.length - 1 && Lk.endTime - Lk.startTime >= CFG.timing.gapMinSec);
	});
	var real = kept.filter(function (Lk) { return !Lk.isGap; });
	if (!real.length) return { mode: MODE.NONE, lines: [] };

	return { mode: totalTags > 0 ? MODE.WORD : MODE.LINE, lines: kept };
}

// Lyric sources
var TF_LYRICS = fb.TitleFormat('$if3(%lyrics%,%unsynced lyrics%,%unsyncedlyrics%,)');
var TF_ARTIST = fb.TitleFormat('%artist%');
var TF_TITLE = fb.TitleFormat('%title%');
var TF_ALBUM = fb.TitleFormat('%album%');

function fileExists(p) {
	try {
		if (has(utils, 'IsFile')) return !!utils.IsFile(p);
		if (has(utils, 'FileTest')) return !!utils.FileTest(p, 'e');
	} catch (e) { /* ignore */ }
	return true;
}

function readText(path) {
	try {
		if (!path || !fileExists(path)) return '';
		var s = '';
		for (var i = 0; i < CFG.readCodePages.length; i++) {
			s = utils.ReadTextFile(path, CFG.readCodePages[i]) || '';
			if (s && s.indexOf('\uFFFD') < 0) break;
		}
		return s.replace(/^\uFEFF/, '');
	} catch (e) { return ''; }
}

function sidecarPath(metadb) {
	var p = String(metadb.Path || '');
	if (/^[a-z]+:\/\//i.test(p) && !/^file:\/\//i.test(p)) return '';
	p = p.replace(/^file:\/\//i, '').replace(/\|\d+$/, '');
	return /\.[^.\\\/]+$/.test(p) ? p.replace(/\.[^.\\\/]+$/, '.lrc') : '';
}

function lyricSources(metadb) {
	return [
		function () { return readText(sidecarPath(metadb)); },
		function () {
			var artist = sanitizeName(TF_ARTIST.EvalWithMetadb(metadb));
			var title = sanitizeName(TF_TITLE.EvalWithMetadb(metadb));
			if (!title) return '';
			var dir = String(fb.ProfilePath || '');
			if (dir && !/[\\\/]$/.test(dir)) dir += '\\';
			for (var i = 0; i < CFG.cachePatterns.length; i++) {
				var name = CFG.cachePatterns[i].replace('{artist}', artist).replace('{title}', title);
				var txt = readText(dir + 'lyrics\\' + name + '.lrc');
				if (txt) return txt;
			}
			return '';
		},
		function () { return String(TF_LYRICS.EvalWithMetadb(metadb) || ''); }
	];
}

function fetchLyrics(metadb) {
	var best = { mode: MODE.NONE, lines: [] };
	if (!metadb) return best;
	var sources = lyricSources(metadb);
	for (var i = 0; i < sources.length; i++) {
		var r = parseLyrics(sources[i]());
		if (r.mode > best.mode) best = r;
		if (best.mode === MODE.WORD) break;
	}
	return best;
}

function playTime() { return fb.PlaybackTime + CFG.timing.lookahead; }

// Layout
function breakBetween(a, b) {
	if (b && CJK_NO_START.test(b.text.charAt(0))) return false;
	if (CJK_NO_END.test(a.text.charAt(a.text.length - 1))) return false;
	return /\s$/.test(a.text) || CJK_RE.test(a.text.charAt(a.text.length - 1)) || (b && CJK_RE.test(b.text.charAt(0)));
}

function layoutLine(L, v, maxW) {
	if (L.isGap || L.blank) {
		L.h[v] = (L.isGap ? CFG.gapHeight : CFG.blankHeight) * S.scale;
		L.rows[v] = [];
		L.subRows[v] = [];
		return;
	}
	var rowH = Fonts.rowH[v], sp = Fonts.spaceW[v];
	var ws = L.words;
	var rows = [''];
	var x = 0, row = 0, i = 0;
	while (i < ws.length) {
		var j = i, uw = 0;
		for (;;) {
			var w = ws[j];
			w.w[v] = Fonts.measureWidth(w.text, v);
			uw += w.w[v];
			if (j + 1 >= ws.length || breakBetween(w, ws[j + 1])) break;
			j++;
		}
		var vis = uw - (/\s$/.test(ws[j].text) ? sp : 0);
		if (x > 0 && x + vis > maxW) { row++; x = 0; rows[row] = ''; }
		for (var k = i; k <= j; k++) {
			ws[k].x[v] = x; ws[k].row[v] = row;
			x += ws[k].w[v];
			rows[row] += ws[k].text;
		}
		i = j + 1;
	}
	L.rows[v] = rows.map(function (r) { return r.replace(/\s+$/, ''); });

	var shouldAlignRight = !!(CFG.rightAlignBacking && L.alignRight);
	if (shouldAlignRight && ws.length) {
		for (var rIdx = 0; rIdx < L.rows[v].length; rIdx++) {
			var rowText = L.rows[v][rIdx];
			var rowWidth = Fonts.measureWidth(rowText, v);
			var rowShift = Math.max(0, maxW - rowWidth);
			if (rowShift > 0) {
				for (var wi = 0; wi < ws.length; wi++) {
					if (ws[wi].row[v] === rIdx) {
						ws[wi].x[v] += rowShift;
					}
				}
			}
		}
	}

	var subRows = [];
	if (L.sub && L.sub.length) {
		var ssp = Fonts.subSpaceW[v];
		for (var sIdx = 0; sIdx < L.sub.length; sIdx++) {
			var subText = L.sub[sIdx];
			var subTokens = tokenize(subText);
			if (!subTokens.length) continue;
			var subWords = subTokens.map(function (t) { return { text: t, w: 0 }; });
			var curSubRows = [''];
			var sx = 0, srow = 0, si = 0;
			while (si < subWords.length) {
				var sj = si, suw = 0;
				for (;;) {
					var sw = subWords[sj];
					sw.w = Fonts.measureSubWidth(sw.text, v);
					suw += sw.w;
					if (sj + 1 >= subWords.length || breakBetween(sw, subWords[sj + 1])) break;
					sj++;
				}
				var svis = suw - (/\s$/.test(subWords[sj].text) ? ssp : 0);
				if (sx > 0 && sx + svis > maxW) { srow++; sx = 0; curSubRows[srow] = ''; }
				for (var sk = si; sk <= sj; sk++) {
					sx += subWords[sk].w;
					curSubRows[srow] += subWords[sk].text;
				}
				si = sj + 1;
			}
			for (var cr = 0; cr < curSubRows.length; cr++) {
				subRows.push(curSubRows[cr].replace(/\s+$/, ''));
			}
		}
	}
	L.subRows[v] = subRows;

	var subH = 0;
	if (subRows.length) {
		var subGap = (CFG.subGap || 4) * S.scale;
		subH = subGap + subRows.length * Fonts.subRowH[v];
	}
	L.h[v] = rows.length * rowH + subH + CFG.lineGap * S.scale;
}

function layoutAll() {
	if (!S.W || !S.lines.length) { S.totalH = 0; return; }
	var maxW = Math.max(40, S.W - S.padX * 2);
	for (var i = 0; i < S.lines.length; i++) {
		var L = S.lines[i];
		layoutLine(L, 0, maxW);
		layoutLine(L, 1, maxW);
	}
}

function variantOf(i) { return i === S.active && S.mode > MODE.PLAIN ? 1 : 0; }

function computeDoc() {
	var y = 0;
	for (var i = 0; i < S.lines.length; i++) {
		S.lines[i].docY = y;
		y += S.lines[i].h[variantOf(i)];
	}
	S.totalH = y;
}

function computeFocus() {
	S.padX = clamp(S.W * CFG.padXRatio, CFG.padXMin, CFG.padXMax);
	S.focusY = S.mode === MODE.PLAIN ? CFG.plainTop * S.scale : S.H * CFG.focusRatio;
}

function anchorPos() {
	var i = Math.max(0, S.active), L = S.lines[i];
	if (!L) return 0;
	return L.docY + (L.h[variantOf(i)] - CFG.lineGap * S.scale) / 2;
}

// Motion & scroll physics
function applyAlpha() {
	for (var i = 0; i < S.lines.length; i++) {
		var L = S.lines[i];
		if (S.mode === MODE.PLAIN) { L.aT = CFG.alpha.plain; continue; }
		var d = Math.abs(i - S.active);
		L.aT = d === 0 ? CFG.alpha.active : d === 1 ? CFG.alpha.near : CFG.alpha.far;
	}
}

function applyTargets(stagger, now) {
	var anchor = Math.max(0, S.active), sp = CFG.spring;
	for (var i = 0; i < S.lines.length; i++) {
		var L = S.lines[i];
		L.pend = L.docY - S.scrollPos + S.focusY;
		L.tgtAt = stagger && i > anchor ? now + Math.min(i - anchor, sp.staggerMax) * sp.stagger : 0;
	}
}

function retarget(snap) {
	computeDoc();
	if (S.mode > MODE.PLAIN && !S.manual) S.scrollPos = anchorPos();
	if (S.mode === MODE.PLAIN) S.scrollPos = clamp(S.scrollPos, 0, Math.max(0, S.totalH - (S.H - S.focusY)));
	applyTargets(!snap && !S.manual, Date.now());
	applyAlpha();
	if (snap) {
		for (var i = 0; i < S.lines.length; i++) {
			var L = S.lines[i];
			L.y = L.tgt = L.pend; L.v = 0; L.tgtAt = 0; L.a = L.aT;
		}
	}
}

function findLine(t) {
	var ls = S.lines, lo = 0, hi = ls.length - 1, r = -1;
	while (lo <= hi) {
		var m = (lo + hi) >> 1;
		if (ls[m].startTime <= t) { r = m; lo = m + 1; } else hi = m - 1;
	}
	return r;
}

function updateActive(t) {
	if (S.mode <= MODE.PLAIN || !S.lines.length) return false;
	var idx = findLine(t);
	if (idx === S.active) return false;
	S.active = idx;
	retarget(false);
	return true;
}

function stepFrame(dt, now) {
	var sp = CFG.spring;
	S.acc += dt;
	var steps = Math.floor(S.acc / sp.step);
	S.acc -= steps * sp.step;
	var H = S.H, k = 1 - Math.exp(-dt * CFG.alphaRate);
	var busy = false;

	for (var i = 0; i < S.lines.length; i++) {
		var L = S.lines[i];
		if (now >= L.tgtAt) L.tgt = L.pend;
		var d = L.y - L.tgt;
		if (d !== 0 || L.v !== 0) {
			var offNow = L.y < -H || L.y > H * 2, offTgt = L.tgt < -H || L.tgt > H * 2;
			if (offNow && offTgt) { L.y = L.tgt; L.v = 0; }
			else {
				if (Math.abs(d) > H * 1.5) L.y = L.tgt + (d > 0 ? 1 : -1) * H * 1.5;
				for (var s = 0; s < steps; s++) {
					var acc = -sp.k * (L.y - L.tgt) - sp.c * L.v;
					L.v += acc * sp.step;
					L.y += L.v * sp.step;
				}
				if (Math.abs(L.y - L.tgt) < sp.restPos && Math.abs(L.v) < sp.restVel) { L.y = L.tgt; L.v = 0; }
				else busy = true;
			}
		}
		if (L.tgtAt > now) busy = true;
		if (L.a !== L.aT) {
			L.a += (L.aT - L.a) * k;
			if (Math.abs(L.aT - L.a) < 0.004) L.a = L.aT; else busy = true;
		}
	}
	return busy;
}

// Background & cover art
var Bg = {
	img: null, w: 0, h: 0, rawArt: null, hasArt: false, cur: [], prev: [], mix: 1, last: 0, dirty: true,
	blobs: [
		{ px: 0.0, py: 1.3, sx: 0.23, sy: 0.19, ax: 0.30, ay: 0.25, r: 0.70, ph: 0.0 },
		{ px: 2.1, py: 0.4, sx: 0.17, sy: 0.27, ax: 0.35, ay: 0.30, r: 0.65, ph: 1.7 },
		{ px: 4.2, py: 2.9, sx: 0.29, sy: 0.15, ax: 0.28, ay: 0.32, r: 0.60, ph: 3.1 },
		{ px: 5.4, py: 5.0, sx: 0.13, sy: 0.22, ax: 0.38, ay: 0.28, r: 0.55, ph: 4.6 }
	]
};

function bgResize() {
	var c = CFG.bg;
	Bg.w = Math.max(c.minSize, Math.ceil(S.W / c.scaleDiv));
	Bg.h = Math.max(c.minSize, Math.ceil(S.H / c.scaleDiv));
	if (Bg.img && has(Bg.img, 'Dispose')) {
		try { Bg.img.Dispose(); } catch (e) {}
	}
	Bg.img = utils.CreateImage(Bg.w, Bg.h);
	Bg.dirty = true;
}

function currentColors() {
	var e = easeOut(Bg.mix);
	var n = Math.max(Bg.cur.length, 1);
	var out = [];
	for (var i = 0; i < n; i++) {
		var a = (Bg.prev.length && Bg.prev[i % Bg.prev.length]) || CFG.bg.defaultColors[i % CFG.bg.defaultColors.length];
		var b = (Bg.cur.length && Bg.cur[i % Bg.cur.length]) || CFG.bg.defaultColors[i % CFG.bg.defaultColors.length];
		out.push(mixRgb(a, b, e));
	}
	return out;
}

function bgRender(now) {
	if (!Bg.img) return;
	var c = CFG.bg, w = Bg.w, h = Bg.h;
	var g = null;
	var useCover = (CFG.bg.mode === 0 && Bg.hasArt && Bg.rawArt);
	try {
		g = Bg.img.GetGraphics();
		if (g) {
			if (useCover) {
				// Cover fit/fill (aspect ratio preserved, centered)
				var artW = 0, artH = 0;
				try { artW = Bg.rawArt.Width; artH = Bg.rawArt.Height; } catch (e1) {}
				if (!artW) artW = 1;
				if (!artH) artH = 1;
				var scale = Math.max(w / artW, h / artH);
				var dw = Math.ceil(artW * scale);
				var dh = Math.ceil(artH * scale);
				var dx = Math.round((w - dw) / 2);
				var dy = Math.round((h - dh) / 2);

				g.Clear(RGB(c.base[0], c.base[1], c.base[2]));
				g.DrawImage(Bg.rawArt, dx, dy, dw, dh, 0, 0, artW, artH, 1);
			} else {
				// Gradient mesh mode: render ambient animated color blobs
				var t = now / 1000;
				var cols = currentColors(), big = Math.max(w, h);
				g.Clear(RGB(c.base[0], c.base[1], c.base[2]));
				for (var i = 0; i < c.blobs; i++) {
					var b = Bg.blobs[i % Bg.blobs.length], col = cols[i % cols.length];
					var cx = w * (0.5 + b.ax * Math.sin(t * b.sx * 6.283 + b.px));
					var cy = h * (0.5 + b.ay * Math.cos(t * b.sy * 6.283 + b.py));
					var rx = big * b.r * (1 + 0.08 * Math.sin(t * 0.9 + b.ph));
					var ry = rx * 0.85;

					var radial_brush = {
						Centre: [cx, cy],
						Radius: [rx, ry],
						Stops: [
							[0.0, RGBA(col[0], col[1], col[2], 210)],
							[0.5, RGBA(col[0], col[1], col[2], 120)],
							[1.0, RGBA(col[0], col[1], col[2], 0)]
						]
					};
					g.FillEllipse(cx - rx, cy - ry, rx * 2, ry * 2, JSON.stringify(radial_brush));
				}
			}
		}
	} finally {
		if (Bg.img && has(Bg.img, 'ReleaseGraphics')) {
			try { Bg.img.ReleaseGraphics(); } catch (e) {}
		}
	}

	if (has(Bg.img, 'StackBlur')) {
		var blurR = useCover ? (c.blurRadius || 18) : Math.max(8, Math.round(Math.max(w, h) / 7));
		Bg.img.StackBlur(blurR);
	}
	Bg.last = now;
	Bg.dirty = false;
}

function extractColors(small) {
	if (!small) return null;
	var list = null;

	// JSP3 / Spider Monkey Panel: GetColourSchemeJSON(count) returns a JSON string
	try {
		if (has(small, 'GetColourSchemeJSON')) {
			var jsonStr = small.GetColourSchemeJSON(4);
			if (jsonStr) {
				var parsed = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
				if (Array.isArray(parsed)) list = parsed;
			}
		}
	} catch (eJSON) { list = null; }

	// Fallback to legacy GetColourScheme(count) if present
	if (!list || !list.length) {
		try {
			if (has(small, 'GetColourScheme')) {
				var scheme = small.GetColourScheme(4);
				if (scheme && has(scheme, 'toArray')) list = scheme.toArray();
				else if (Array.isArray(scheme)) list = scheme;
			}
		} catch (eCS) { list = null; }
	}

	if (!list || !list.length) return null;
	var out = [];
	for (var i = 0; i < list.length && out.length < 4; i++) {
		var item = list[i];
		var colVal = typeof item === 'number' ? item : (item && (item.colour !== undefined ? item.colour : (item.col !== undefined ? item.col : item.color)));
		if (typeof colVal === 'number') out.push(vibrant(colVal));
	}
	return out.length ? out : null;
}

function hashColors(seed) {
	var base = (hashString(seed) % 360) / 360, out = [];
	for (var i = 0; i < 4; i++) out.push(hslToRgb((base + i * 0.09) % 1, 0.55, 0.42));
	return out;
}

function unwrapImage(img) {
	if (!img) return null;
	if (typeof img === 'string') {
		if (typeof utils !== 'undefined' && typeof utils.LoadImage !== 'undefined') {
			try {
				var loaded = utils.LoadImage(img);
				if (loaded) return unwrapImage(loaded);
			} catch (eStr) {}
		}
		return null;
	}
	if (typeof img.Width !== 'undefined' && img.Width > 0) return img;
	if (typeof img.Height !== 'undefined' && img.Height > 0) return img;
	if (typeof img.width !== 'undefined' && img.width > 0) return img;
	if (typeof img.height !== 'undefined' && img.height > 0) return img;

	var props = ['image', 'img', 'Image', 'Bitmap', 'bitmap', 'Picture', 'picture', 'data'];
	for (var p = 0; p < props.length; p++) {
		if (img[props[p]]) {
			var inner = unwrapImage(img[props[p]]);
			if (inner) return inner;
		}
	}

	var pathProps = ['Path', 'path', 'filePath', 'FilePath'];
	for (var pp = 0; pp < pathProps.length; pp++) {
		var pVal = img[pathProps[pp]];
		if (pVal && typeof pVal === 'string' && typeof utils !== 'undefined' && typeof utils.LoadImage !== 'undefined') {
			try {
				var fromPath = utils.LoadImage(pVal);
				if (fromPath) {
					var innerP = unwrapImage(fromPath);
					if (innerP) return innerP;
				}
			} catch (eP) {}
		}
	}

	if (img.toArray) {
		try {
			var arr = img.toArray();
			for (var a = 0; a < arr.length; a++) {
				var u = unwrapImage(arr[a]);
				if (u) return u;
			}
		} catch (e) {}
	}
	if (Array.isArray(img) || (typeof img.length === 'number' && typeof img !== 'string' && img.length > 0)) {
		for (var k = 0; k < img.length; k++) {
			var unwrapped = unwrapImage(img[k]);
			if (unwrapped) return unwrapped;
		}
	}
	return (typeof img.Width !== 'undefined' || typeof img.Height !== 'undefined') ? img : null;
}

function findAlbumArt(metadb) {
	if (!metadb) return null;
	var art = null;
	var artTypes = [0, 2, 1, 3, 4];

	// Extract real, clean, decoded path from metadb
	var realPath = '';
	try {
		if (typeof fb !== 'undefined' && fb.TitleFormat) {
			realPath = fb.TitleFormat('%path%').EvalWithMetadb(metadb);
		}
	} catch (eTF) {}
	if (!realPath) {
		realPath = String(metadb.Path || '').replace(/^file:\/\//i, '').replace(/\|\d+$/, '');
		try { realPath = decodeURIComponent(realPath); } catch (eDec) {}
	}

	// Synchronous album art lookup (want_stub false avoids default placeholder)
	for (var i = 0; i < artTypes.length; i++) {
		try {
			if (has(metadb, 'GetAlbumArt')) {
				art = unwrapImage(metadb.GetAlbumArt(artTypes[i], false));
				if (art) return art;
			}
		} catch (e1) {}
	}

	// Read embedded artwork from file tags via metadb handle
	for (var ie = 0; ie < artTypes.length; ie++) {
		try {
			if (has(metadb, 'GetAlbumArtEmbedded')) {
				art = unwrapImage(metadb.GetAlbumArtEmbedded(artTypes[ie]));
				if (art) return art;
			}
		} catch (e1b) {}
	}
	try {
		if (has(metadb, 'GetAlbumArtEmbedded')) {
			art = unwrapImage(metadb.GetAlbumArtEmbedded());
			if (art) return art;
		}
	} catch (e1c) {}

	// Fallback via utils.GetAlbumArtV2
	for (var j = 0; j < artTypes.length; j++) {
		try {
			if (typeof utils !== 'undefined' && typeof utils.GetAlbumArtV2 !== 'undefined') {
				art = unwrapImage(utils.GetAlbumArtV2(metadb, artTypes[j], false));
				if (art) return art;
				art = unwrapImage(utils.GetAlbumArtV2(metadb, artTypes[j]));
				if (art) return art;
			}
		} catch (e2) {}
	}

	// Embedded tag reader via utils
	if (typeof utils !== 'undefined' && typeof utils.GetAlbumArtEmbedded !== 'undefined') {
		for (var k = 0; k < artTypes.length; k++) {
			var type = artTypes[k];
			try {
				if (metadb.RawPath) {
					art = unwrapImage(utils.GetAlbumArtEmbedded(metadb.RawPath, type));
					if (art) return art;
				}
			} catch (eE1) {}
			try {
				if (realPath) {
					art = unwrapImage(utils.GetAlbumArtEmbedded(realPath, type));
					if (art) return art;
				}
			} catch (eE2) {}
			try {
				if (metadb.Path) {
					art = unwrapImage(utils.GetAlbumArtEmbedded(metadb.Path, type));
					if (art) return art;
				}
			} catch (eE3) {}
			try {
				art = unwrapImage(utils.GetAlbumArtEmbedded(metadb, type));
				if (art) return art;
			} catch (eE4) {}
		}
		try {
			if (metadb.RawPath) {
				art = unwrapImage(utils.GetAlbumArtEmbedded(metadb.RawPath));
				if (art) return art;
			}
		} catch (eE5) {}
		try {
			if (realPath) {
				art = unwrapImage(utils.GetAlbumArtEmbedded(realPath));
				if (art) return art;
			}
		} catch (eE6) {}
	}

	// Directory search matching foobar2000 album art patterns
	try {
		var fn = '', album = '', artist = '', title = '', dir = '';
		if (typeof fb !== 'undefined' && fb.TitleFormat) {
			try { fn = fb.TitleFormat('%filename%').EvalWithMetadb(metadb); } catch (eF) {}
			try { album = fb.TitleFormat('%album%').EvalWithMetadb(metadb); } catch (eA) {}
			try { artist = fb.TitleFormat('%artist%').EvalWithMetadb(metadb); } catch (eAr) {}
			try { title = fb.TitleFormat('%title%').EvalWithMetadb(metadb); } catch (eT) {}
			try { dir = fb.TitleFormat('$directory_path(%path%)').EvalWithMetadb(metadb); } catch (eD) {}
		}
		if (!dir || dir === '?') {
			var p = realPath || String(metadb.Path || '').replace(/^file:\/\//i, '').replace(/\|\d+$/, '');
			var slash = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
			if (slash > 0) dir = p.slice(0, slash);
		}

		if (dir && typeof utils !== 'undefined') {
			var imgExts = /\.(jpe?g|png|webp|bmp|gif)$/i;

			// Directory scan via utils.ListFiles
			if (typeof utils.ListFiles !== 'undefined') {
				try {
					var rawList = utils.ListFiles(dir);
					var fileList = (rawList && rawList.toArray) ? rawList.toArray() : (Array.isArray(rawList) ? rawList : []);
					if (fileList && fileList.length) {
						var imgFiles = [];
						for (var fl = 0; fl < fileList.length; fl++) {
							var fp = fileList[fl];
							if (imgExts.test(fp)) {
								var fnPart = fp.slice(Math.max(fp.lastIndexOf('\\'), fp.lastIndexOf('/')) + 1);
								var stem = fnPart.replace(imgExts, '').toLowerCase();
								imgFiles.push({ path: fp, stem: stem });
							}
						}

						if (imgFiles.length) {
							// Match common cover filenames in priority order
							var patterns = ['front', 'cover'];
							if (fn) patterns.push(fn.toLowerCase());
							if (album) patterns.push(album.toLowerCase());
							patterns.push('folder');
							patterns.push('artwork');
							patterns.push('album');
							if (artist && album) patterns.push((artist + ' - ' + album).toLowerCase());
							if (artist && title) patterns.push((artist + ' - ' + title).toLowerCase());
							patterns.push('default');

							for (var patIdx = 0; patIdx < patterns.length; patIdx++) {
								var patStem = patterns[patIdx];
								for (var im1 = 0; im1 < imgFiles.length; im1++) {
									if (imgFiles[im1].stem === patStem) {
										art = unwrapImage(utils.LoadImage(imgFiles[im1].path));
										if (art) return art;
									}
								}
							}

							// Substring match for filenames with special punctuation differences (e.g. ';' vs ',')
							if (fn || album) {
								var fnNorm = fn ? fn.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
								var albNorm = album ? album.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
								for (var im2 = 0; im2 < imgFiles.length; im2++) {
									var normStem = imgFiles[im2].stem.replace(/[^a-z0-9]/g, '');
									if ((fnNorm && normStem === fnNorm) || (albNorm && normStem === albNorm)) {
										art = unwrapImage(utils.LoadImage(imgFiles[im2].path));
										if (art) return art;
									}
								}
							}

							// Fallback: any image in the directory
							for (var im3 = 0; im3 < imgFiles.length; im3++) {
								art = unwrapImage(utils.LoadImage(imgFiles[im3].path));
								if (art) return art;
							}
						}
					}
				} catch (eLF) {}
			}

			// Direct file checks
			if (typeof utils.IsFile !== 'undefined' && typeof utils.LoadImage !== 'undefined') {
				var candidates = ['front', 'cover'];
				if (fn) {
					candidates.push(fn);
					if (fn.indexOf(';') >= 0) candidates.push(fn.replace(/;/g, ','));
					if (fn.indexOf(',') >= 0) candidates.push(fn.replace(/,/g, ';'));
				}
				if (album) {
					candidates.push(album);
					if (album.indexOf(';') >= 0) candidates.push(album.replace(/;/g, ','));
					if (album.indexOf(',') >= 0) candidates.push(album.replace(/,/g, ';'));
				}
				candidates.push('folder');
				candidates.push('artwork');
				candidates.push('album');
				if (artist && album) candidates.push(artist + ' - ' + album);
				if (artist && title) candidates.push(artist + ' - ' + title);
				candidates.push('default');

				var exts = ['.jpg', '.jpeg', '.png', '.webp', '.bmp'];
				for (var cIdx = 0; cIdx < candidates.length; cIdx++) {
					for (var eIdx = 0; eIdx < exts.length; eIdx++) {
						var candPath = dir + '\\' + candidates[cIdx] + exts[eIdx];
						if (utils.IsFile(candPath)) {
							art = unwrapImage(utils.LoadImage(candPath));
							if (art) return art;
						}
					}
				}
			}
		}
	} catch (eDir) {}

	return null;
}

function setCoverArt(art, metadb) {
	var image = unwrapImage(art);
	if (Bg.rawArt && Bg.rawArt !== image) {
		try {
			if (has(Bg.rawArt, 'Dispose')) Bg.rawArt.Dispose();
		} catch (e) {}
	}
	Bg.rawArt = image;
	Bg.hasArt = !!image;
	if (image) {
		var colors = extractColors(image);
		if (!colors && metadb) {
			colors = hashColors(String(TF_ALBUM.EvalWithMetadb(metadb)) + String(TF_ARTIST.EvalWithMetadb(metadb)));
		}
		if (colors) {
			Bg.prev = Bg.cur.length ? Bg.cur : CFG.bg.defaultColors;
			Bg.cur = colors;
			Bg.mix = 0;
		}
	} else if (metadb) {
		var hColors = hashColors(String(TF_ALBUM.EvalWithMetadb(metadb)) + String(TF_ARTIST.EvalWithMetadb(metadb)));
		if (hColors) {
			Bg.prev = Bg.cur.length ? Bg.cur : CFG.bg.defaultColors;
			Bg.cur = hColors;
			Bg.mix = 0;
		}
	}
	Bg.dirty = true;
}

function loadArt(metadb) {
	if (!metadb) {
		setCoverArt(null, null);
		return;
	}
	var art = findAlbumArt(metadb);
	setCoverArt(art, metadb);

	// If art was not found synchronously, request it asynchronously and schedule retries
	if (!art) {
		// Promise-based utils.GetAlbumArtAsyncV2
		if (typeof utils !== 'undefined' && typeof utils.GetAlbumArtAsyncV2 !== 'undefined') {
			for (var vIdx = 0; vIdx < 2; vIdx++) {
				var vType = vIdx === 0 ? 0 : 2;
				try {
					var p = utils.GetAlbumArtAsyncV2(metadb, vType);
					if (p && typeof p.then === 'function') {
						p.then(function (res) {
							var resImg = unwrapImage(res);
							var curT = S.track || (typeof fb !== 'undefined' && fb.IsPlaying ? fb.GetNowPlaying() : null);
							if (resImg && curT && (curT === metadb || (curT.Path && metadb.Path && curT.Path === metadb.Path))) {
								setCoverArt(resImg, curT);
								window.Repaint();
							}
						})['catch'](function () {});
					}
				} catch (ePr) {}
			}
		}

		// Callback-based metadb.GetAlbumArtAsync
		if (has(metadb, 'GetAlbumArtAsync') && typeof window.ID !== 'undefined') {
			for (var aIdx = 0; aIdx < 3; aIdx++) {
				var aType = (aIdx === 0) ? 0 : (aIdx === 1 ? 2 : 1);
				try {
					metadb.GetAlbumArtAsync(window.ID, aType);
				} catch (eAsync) {}
			}
		}

		// Delayed retries while foobar2000 parses tags
		if (typeof window.SetTimeout !== 'undefined') {
			var scheduleRetry = function (delay) {
				try {
					window.SetTimeout(function () {
						var cur = S.track || (typeof fb !== 'undefined' && fb.IsPlaying ? fb.GetNowPlaying() : null);
						if (!Bg.hasArt && cur && (cur === metadb || (cur.Path && metadb.Path && cur.Path === metadb.Path))) {
							var delayedArt = findAlbumArt(metadb);
							if (delayedArt) {
								setCoverArt(delayedArt, cur);
								window.Repaint();
							}
						}
					}, delay);
				} catch (eTimer) {}
			};
			scheduleRetry(150);
			scheduleRetry(400);
			scheduleRetry(900);
		}
	}
}

// Rendering
function drawBackground(gr, W, H) {
	var c = CFG.bg;
	if (!Bg.img || Bg.w !== Math.max(c.minSize, Math.ceil(W / c.scaleDiv)) || Bg.h !== Math.max(c.minSize, Math.ceil(H / c.scaleDiv))) {
		bgResize();
	}
	var isCover = (CFG.bg.mode === 0 && Bg.hasArt && Bg.rawArt);
	if (Bg.img) {
		if (Bg.dirty) bgRender(Date.now());
		gr.DrawImage(Bg.img, 0, 0, W, H, 0, 0, Bg.w, Bg.h, 1);
		var tint = isCover ? c.tint : (c.gradientTint || 0.35);
		gr.FillRectangle(0, 0, W, H, RGBA(0, 0, 0, tint * 255));
	} else {
		var linear_brush = {
			Start: [0, 0],
			End: [0, H],
			Stops: [
				[0.0, RGB(c.slateTop[0], c.slateTop[1], c.slateTop[2])],
				[1.0, RGB(c.slateBottom[0], c.slateBottom[1], c.slateBottom[2])]
			]
		};
		gr.FillRectangle(0, 0, W, H, JSON.stringify(linear_brush));
	}
}

function drawGapDots(gr, L, t, a) {
	var d = 8 * S.scale, step = 16 * S.scale;
	var dur = Math.max(0.001, L.endTime - L.startTime);
	var p = S.mode === MODE.PLAIN ? 0 : clamp((t - L.startTime) / dur, 0, 1);
	var cy = L.y + L.h[0] / 2 - d / 2;
	for (var k = 0; k < 3; k++) {
		var f = clamp(p * 3 - k, 0, 1);
		gr.FillEllipse(S.padX + k * step, cy, d, d, white(a * (0.3 + 0.7 * f)));
	}
}

function drawActiveLine(gr, L, t, a) {
	var fontStr = Fonts.str[1], rowH = Fonts.rowH[1];
	var inactiveCol = white(a * CFG.alpha.inactiveWord);
	var fullCol = white(a);
	var dynamicWords = [];

	var enterLimit = (CFG.wordTransition ? CFG.wordTransition.enterMaxMs : 300) / 1000;
	var settleLimit = (CFG.wordTransition ? CFG.wordTransition.settleMs : 350) / 1000;

	for (var i = 0; i < L.words.length; i++) {
		var w = L.words[i];
		var x = S.padX + w.x[1], baseY = L.y + w.row[1] * rowH;
		var dur = Math.max(0.001, w.endTime - w.startTime);
		var settleDur = Math.min(settleLimit, Math.max(0.12, dur * 1.5));

		if (t < w.startTime) {
			// Inactive future word: dim
			gr.WriteText(w.text, fontStr, inactiveCol, x, baseY, w.w[1] + 4, rowH, DWRITE_TEXT_ALIGNMENT_LEADING, DWRITE_PARAGRAPH_ALIGNMENT_NEAR, DWRITE_WORD_WRAPPING_NO_WRAP);
		} else if (t >= w.endTime + settleDur) {
			// Played & settled word: solid white
			gr.WriteText(w.text, fontStr, fullCol, x, baseY, w.w[1] + 4, rowH, DWRITE_TEXT_ALIGNMENT_LEADING, DWRITE_PARAGRAPH_ALIGNMENT_NEAR, DWRITE_WORD_WRAPPING_NO_WRAP);
		} else {
			// Currently active or settling: process dynamically with smooth interpolation
			dynamicWords.push({ w: w, x: x, baseY: baseY, dur: dur, settleDur: settleDur });
		}
	}

	// Currently active / settling words drawn on top with smooth rise, optical bloom & landing glide
	for (var j = 0; j < dynamicWords.length; j++) {
		var item = dynamicWords[j];
		var dw = item.w;
		var ax = item.x;
		var abaseY = item.baseY;
		var ddur = item.dur;
		var dsettle = item.settleDur;

		var bigW = Fonts.measureWidth(dw.text, 2);
		// Cap horizontal expansion so it never overlaps neighboring words or characters
		var maxExpansion = Math.min(Fonts.spaceW[1] * 0.35, Math.min(2 * S.scale, (bigW - dw.w[1]) / 2));
		var shiftX = Math.max(0, maxExpansion);
		var drawX = Math.max(0, ax - shiftX);
		var activeFontStr = Fonts.str[2] || fontStr;
		var maxLift = Math.min(rowH * 0.08, CFG.activeWordLift * S.scale);
		var boxH = (Fonts.rowH[2] || rowH) + Math.ceil(maxLift) + 2;
		var drawW = Math.max(dw.w[1] + 4, bigW + 4);

		var sFactor = 1.0;
		var normalAlpha = 0;
		var activeAlpha = a;

		if (t < dw.endTime) {
			// Word is actively being sung
			var enterDur = Math.min(enterLimit, Math.max(0.10, ddur * 0.75));
			var enterT = clamp((t - dw.startTime) / enterDur, 0, 1);
			sFactor = enterT * enterT * (3 - 2 * enterT); // smoothstep 0 -> 1
			activeAlpha = a * sFactor;
			normalAlpha = (1 - sFactor) * a * (CFG.alpha.inactiveWord + (1 - CFG.alpha.inactiveWord) * enterT);
		} else {
			// Word just finished: smoothly glide down and fade glow over settleDur
			var settleT = clamp((t - dw.endTime) / dsettle, 0, 1);
			sFactor = 1 - (settleT * settleT * (3 - 2 * settleT)); // smoothstep 1 -> 0
			activeAlpha = a * sFactor;
			normalAlpha = a * (1 - sFactor);
		}

		var liftY = abaseY - maxLift * sFactor;

		// Base text layer
		if (normalAlpha > 0.01) {
			gr.WriteText(dw.text, fontStr, white(normalAlpha), ax, abaseY, dw.w[1] + 4, rowH, DWRITE_TEXT_ALIGNMENT_LEADING, DWRITE_PARAGRAPH_ALIGNMENT_NEAR, DWRITE_WORD_WRAPPING_NO_WRAP);
		}

		// Glow bloom around active lifted word
		if (CFG.glow && sFactor > 0.02) {
			var ga = a * 0.28 * sFactor, o = 1.5 * S.scale;
			var glowCol = white(ga);
			gr.WriteText(dw.text, activeFontStr, glowCol, drawX - o, liftY, drawW, boxH, DWRITE_TEXT_ALIGNMENT_LEADING, DWRITE_PARAGRAPH_ALIGNMENT_NEAR, DWRITE_WORD_WRAPPING_NO_WRAP);
			gr.WriteText(dw.text, activeFontStr, glowCol, drawX + o, liftY, drawW, boxH, DWRITE_TEXT_ALIGNMENT_LEADING, DWRITE_PARAGRAPH_ALIGNMENT_NEAR, DWRITE_WORD_WRAPPING_NO_WRAP);
			gr.WriteText(dw.text, activeFontStr, glowCol, drawX, liftY - o, drawW, boxH, DWRITE_TEXT_ALIGNMENT_LEADING, DWRITE_PARAGRAPH_ALIGNMENT_NEAR, DWRITE_WORD_WRAPPING_NO_WRAP);
			gr.WriteText(dw.text, activeFontStr, glowCol, drawX, liftY + o, drawW, boxH, DWRITE_TEXT_ALIGNMENT_LEADING, DWRITE_PARAGRAPH_ALIGNMENT_NEAR, DWRITE_WORD_WRAPPING_NO_WRAP);
		}

		// Lifted active word with optical zoom
		if (activeAlpha > 0.01) {
			gr.WriteText(dw.text, activeFontStr, white(activeAlpha), drawX, liftY, drawW, boxH, DWRITE_TEXT_ALIGNMENT_LEADING, DWRITE_PARAGRAPH_ALIGNMENT_NEAR, DWRITE_WORD_WRAPPING_NO_WRAP);
		}
	}
}

function drawSubRows(gr, L, v, a, W) {
	if (!L.subRows || !L.subRows[v] || !L.subRows[v].length) return;
	var fontStr = Fonts.subStr[v];
	var rowH = Fonts.subRowH[v];
	var maxRowW = Math.max(40, W - S.padX * 2);
	var subGap = (CFG.subGap || 4) * S.scale;
	var subY = L.y + L.rows[v].length * Fonts.rowH[v] + subGap;
	var subAlpha = v === 1 ? a * 0.90 : a * 0.78;
	var col = white(subAlpha);
	var align = (CFG.rightAlignBacking && L.alignRight) ? DWRITE_TEXT_ALIGNMENT_TRAILING : DWRITE_TEXT_ALIGNMENT_LEADING;
	for (var sr = 0; sr < L.subRows[v].length; sr++) {
		gr.WriteText(L.subRows[v][sr], fontStr, col, S.padX, subY + sr * rowH, maxRowW, rowH, align, DWRITE_PARAGRAPH_ALIGNMENT_NEAR, DWRITE_WORD_WRAPPING_NO_WRAP);
	}
}

function drawLyrics(gr, W, H) {
	var t = playTime();
	var fade = Math.max(1, H * CFG.edgeFade);
	for (var i = 0; i < S.lines.length; i++) {
		var L = S.lines[i];
		var isActive = i === S.active && S.mode > MODE.PLAIN, v = isActive ? 1 : 0;
		var h = L.h[v];
		if (L.y + h < -20 || L.y > H + 20 || L.blank) continue;
		var mid = L.y + h * 0.5;
		var a = L.a * (0.12 + 0.88 * clamp(Math.min(mid, H - mid) / fade, 0, 1));
		if (a < 0.01) continue;

		if (L.isGap) {
			drawGapDots(gr, L, t, a);
			continue;
		}

		if (isActive && L.timed) {
			drawActiveLine(gr, L, t, a);
			drawSubRows(gr, L, 1, a, W);
			continue;
		}

		var rows = L.rows[v], rowH = Fonts.rowH[v], fontStr = Fonts.str[v];
		var col = white(a);
		var maxRowW = Math.max(40, W - S.padX * 2);
		var align = (CFG.rightAlignBacking && L.alignRight) ? DWRITE_TEXT_ALIGNMENT_TRAILING : DWRITE_TEXT_ALIGNMENT_LEADING;
		for (var r = 0; r < rows.length; r++) {
			gr.WriteText(rows[r], fontStr, col, S.padX, L.y + r * rowH, maxRowW, rowH, align, DWRITE_PARAGRAPH_ALIGNMENT_NEAR, DWRITE_WORD_WRAPPING_NO_WRAP);
		}
		drawSubRows(gr, L, v, a, W);
	}
}

function drawMessage(gr, W, H) {
	var msg = S.playing ? 'No lyrics found' : 'Nothing playing';
	gr.WriteText(msg, Fonts.str[0], white(0.45), 0, 0, W, Math.round(H * 0.8), DWRITE_TEXT_ALIGNMENT_CENTER, DWRITE_PARAGRAPH_ALIGNMENT_CENTER, DWRITE_WORD_WRAPPING_NO_WRAP);
}

function on_paint(gr) {
	var W = window.Width, H = window.Height;
	if (!W || !H) return;
	drawBackground(gr, W, H);
	if (!Fonts.str[0]) return;
	if (S.lines.length) drawLyrics(gr, W, H);
	else drawMessage(gr, W, H);
}

// Timer & events
function setTimerRate(ms) {
	if (S.timerMs === ms) return;
	if (S.timer) { window.ClearInterval(S.timer); S.timer = 0; }
	S.timerMs = ms;
	if (ms) S.timer = window.SetInterval(onTimer, ms);
}

function ensureTimer(hot) {
	var live = S.playing && !S.paused;
	var wantRetry = S.playing && S.mode <= MODE.PLAIN && S.tries < CFG.retry.max;
	var wantResume = S.manual && S.mode > MODE.PLAIN;
	var wantBgAnim = live && (CFG.bg.mode === 1 || !Bg.rawArt);
	setTimerRate(hot ? CFG.tick.hotMs : (live || wantRetry || wantResume || wantBgAnim) ? CFG.tick.pollMs : 0);
}

function onTimer() {
	var now = Date.now();
	var dt = clamp((now - (S.lastTick || now)) / 1000, 0, 0.05);
	S.lastTick = now;
	var dirty = false;
	var live = S.playing && !S.paused;

	if (live && updateActive(playTime())) dirty = true;

	if (S.manual && S.mode > MODE.PLAIN && !S.drag && now - S.lastUser >= CFG.resumeMs) {
		S.manual = false;
		retarget(false);
		dirty = true;
	}

	if (S.playing && S.mode <= MODE.PLAIN && S.tries < CFG.retry.max && now >= S.nextRetry) {
		S.tries++;
		S.nextRetry = now + CFG.retry.everyMs;
		var r = fetchLyrics(S.track);
		if (r.mode > S.mode) { setLyrics(r); dirty = true; }
	}

	var moving = stepFrame(dt, now);
	if (moving) dirty = true;

	if (Bg.mix < 1) { Bg.mix = Math.min(1, Bg.mix + dt / CFG.bg.mixSeconds); Bg.dirty = true; dirty = true; }
	var animBg = (CFG.bg.mode === 1 || !Bg.rawArt) && live;
	if (Bg.dirty || (animBg && now - Bg.last >= 1000 / CFG.bg.fps)) { bgRender(now); dirty = true; }

	var hotWord = false;
	if (live && S.active >= 0) {
		var L = S.lines[S.active];
		hotWord = !!(L && L.timed && playTime() < L.endTime + 0.3);
	}
	if (hotWord) dirty = true;
	S.hotWord = hotWord;

	if (dirty) window.Repaint();
	ensureTimer(moving || hotWord || Bg.mix < 1);
	if (!S.timer) S.lastTick = 0;
}

function setLyrics(res) {
	S.mode = res.mode;
	S.lines = res.lines;
	S.active = -1;
	S.manual = false;
	S.scrollPos = 0;
	S.acc = 0;
	computeFocus();
	layoutAll();
	if (S.playing && S.mode > MODE.PLAIN) S.active = findLine(playTime());
	retarget(true);
}

function loadTrack(metadb) {
	S.track = metadb;
	S.tries = 0;
	S.nextRetry = Date.now() + CFG.retry.everyMs;
	S.playing = fb.IsPlaying;
	S.paused = fb.IsPaused;
	loadArt(metadb);
	setLyrics(fetchLyrics(metadb));
	window.Repaint();
	ensureTimer(true);
}

function clearTrack() {
	S.track = null;
	S.playing = false;
	S.paused = false;
	setCoverArt(null, null);
	setLyrics({ mode: MODE.NONE, lines: [] });
	setTimerRate(0);
	S.lastTick = 0;
	window.Repaint();
}

function relayout(snap) {
	var sc = clamp(Math.round(S.W / CFG.baseWidth * 20) / 20, CFG.scaleMin, CFG.scaleMax);
	if (!Fonts.str[0] || sc !== S.scale) Fonts.build(sc);
	computeFocus();
	layoutAll();
	retarget(snap);
}

function on_size() {
	var W = window.Width, H = window.Height;
	if (!W || !H || (W === S.W && H === S.H)) return;
	S.W = W; S.H = H;
	relayout(true);
	bgResize();
	window.Repaint();
	if (S.playing) ensureTimer(true);
}

function on_playback_new_track(metadb) {
	loadTrack(metadb || fb.GetNowPlaying());
}

function on_playback_stop(reason) {
	if (reason === 2) return;
	clearTrack();
}

function on_playback_pause(state) {
	S.paused = !!state;
	window.Repaint();
	ensureTimer(!S.paused && S.hotWord);
}

function on_playback_seek() {
	S.playing = fb.IsPlaying;
	updateActive(playTime());
	window.Repaint();
	ensureTimer(true);
}

function on_get_album_art_done(metadb, art_id, image, image_path) {
	var img = unwrapImage(image);
	if (!img && image_path && typeof utils !== 'undefined' && typeof utils.LoadImage !== 'undefined') {
		try {
			img = unwrapImage(utils.LoadImage(image_path));
		} catch (ePath) {}
	}
	var cur = S.track || (typeof fb !== 'undefined' && fb.IsPlaying ? fb.GetNowPlaying() : null);
	if (img && cur) {
		var match = false;
		try {
			if (cur === metadb) match = true;
			else if (cur.Compare && cur.Compare(metadb)) match = true;
			else if (cur.Path && metadb && metadb.Path && cur.Path === metadb.Path) match = true;
			else if (!metadb) match = true;
		} catch (e) { match = true; }
		if (match) {
			setCoverArt(img, cur);
			window.Repaint();
		}
	}
}

// foobar2000 signals that embedded/stream artwork has been (re)decoded for the playing track
function on_playback_dynamic_info_track(type) {
	if (type === 1 && S.track) {
		loadArt(S.track);
		window.Repaint();
	}
}

function on_item_focus_change() {
	if (typeof fb !== 'undefined' && !fb.IsPlaying) {
		var f = null;
		try { f = fb.GetFocusItem(); } catch (e) {}
		if (f) { loadArt(f); window.Repaint(); }
	}
}

function on_metadb_changed(handles) {
	if (!S.track) return;
	var found = false;
	try {
		if (!handles) found = true;
		else if (handles.Find && handles.Find(S.track) !== -1) found = true;
		else if (handles.indexOf && handles.indexOf(S.track) !== -1) found = true;
		else if (handles.length) {
			for (var i = 0; i < handles.length; i++) {
				if (handles[i] === S.track || (handles[i].Path && S.track.Path && handles[i].Path === S.track.Path)) {
					found = true; break;
				}
			}
		} else {
			found = true;
		}
	} catch (e) { found = true; }
	if (found) {
		loadArt(S.track);
		window.Repaint();
	}
}

function lineAt(y) {
	for (var i = 0; i < S.lines.length; i++) {
		var L = S.lines[i];
		if (!L.blank && y >= L.y && y < L.y + L.h[variantOf(i)]) return i;
	}
	return -1;
}

function maxScroll() {
	return Math.max(0, S.mode === MODE.PLAIN ? S.totalH - (S.H - S.focusY) : S.totalH);
}

function noteUserScroll() {
	S.manual = true;
	S.lastUser = Date.now();
	applyTargets(false, S.lastUser);
	ensureTimer(true);
}

function on_mouse_wheel(step) {
	if (!S.lines.length) return;
	S.scrollPos = clamp(S.scrollPos - step * CFG.wheelPx * S.scale, 0, maxScroll());
	noteUserScroll();
}

function on_mouse_lbtn_down(x, y) {
	S.drag = { y: y, start: S.scrollPos, moved: false };
}

function on_mouse_move(x, y) {
	var d = S.drag;
	if (d) {
		var dy = y - d.y;
		if (!d.moved && Math.abs(dy) > CFG.dragThreshold) d.moved = true;
		if (d.moved) {
			S.scrollPos = clamp(d.start - dy, 0, maxScroll());
			noteUserScroll();
		}
		return;
	}
	if (has(window, 'SetCursor')) {
		var hand = S.mode > MODE.PLAIN && S.playing && lineAt(y) >= 0;
		if (hand !== S.hand) { S.hand = hand; window.SetCursor(hand ? IDC_HAND : IDC_ARROW); }
	}
}

function on_mouse_lbtn_up(x, y) {
	var d = S.drag;
	S.drag = null;
	if (d && d.moved) { S.lastUser = Date.now(); return; }
	if (S.mode <= MODE.PLAIN || !S.playing) return;
	var i = lineAt(y);
	if (i < 0) return;
	fb.PlaybackTime = S.lines[i].startTime;
	S.manual = false;
	S.active = i;
	retarget(false);
	window.Repaint();
	ensureTimer(true);
}

function on_mouse_leave() {
	S.drag = null;
	if (S.hand && has(window, 'SetCursor')) { S.hand = false; window.SetCursor(IDC_ARROW); }
}

function setBackgroundMode(mode) {
	CFG.bg.mode = mode === 1 ? 1 : 0;
	if (typeof window.SetProperty !== 'undefined') {
		window.SetProperty('Lyrics.Background.Mode', CFG.bg.mode);
	}
	Bg.dirty = true;
	window.Repaint();
	if (S.playing) ensureTimer(true);
}

function on_key_down(vkey) {
	// 'B' key (VK_B = 66) toggles between Cover Image and Gradient background
	if (vkey === 66) {
		setBackgroundMode(CFG.bg.mode === 0 ? 1 : 0);
	}
}

function persistProp(name, val) {
	if (typeof window.SetProperty !== 'undefined') {
		try { window.SetProperty(name, val); } catch (e) {}
	}
}

// Re-measure everything after a typography change (font family / size / line gap)
function applyTypography() {
	Fonts.face = null;
	Fonts.str[0] = '';
	if (S.W && S.H) relayout(true);
	window.Repaint();
	if (S.playing) ensureTimer(true);
}

function listInstalledFonts() {
	var out = [], seen = {};
	try {
		if (has(utils, 'ListFonts')) {
			var raw = utils.ListFonts();
			var arr = (raw && has(raw, 'toArray')) ? raw.toArray() : raw;
			if (arr && typeof arr.length === 'number') {
				for (var i = 0; i < arr.length; i++) {
					var n = String(arr[i]);
					if (!n || n.charAt(0) === '@' || seen[n]) continue;
					seen[n] = true;
					out.push(n);
				}
			}
		}
	} catch (e) {}
	out.sort(function (a, b) {
		var x = a.toLowerCase(), y = b.toLowerCase();
		return x < y ? -1 : (x > y ? 1 : 0);
	});
	return out;
}

var MENU_GAPS = [['Tight', 6], ['Compact', 10], ['Normal', 16], ['Relaxed', 24], ['Wide', 34]];
var MENU_SIZES = [['Small (85%)', 0.85], ['Normal (100%)', 1], ['Large (115%)', 1.15], ['Extra Large (130%)', 1.3]];

function on_mouse_rbtn_up(x, y) {
	// If Shift is pressed, allow default host menu (Properties / Configure)
	if (typeof utils.IsKeyPressed !== 'undefined' && utils.IsKeyPressed(0x10)) {
		return false;
	}
	if (typeof window.CreatePopupMenu === 'undefined') return true;

	var menu = window.CreatePopupMenu();
	if (!menu) return true;

	var MF_CHECKED = 0x00000008;
	var MF_STRING = 0x00000000;
	var MF_SEPARATOR = 0x00000800;
	var canSub = has(menu, 'AppendTo');
	var i;

	menu.AppendMenuItem(CFG.bg.mode === 0 ? MF_CHECKED : MF_STRING, 1, 'Background: Blurred Album Cover');
	menu.AppendMenuItem(CFG.bg.mode === 1 ? MF_CHECKED : MF_STRING, 2, 'Background: Animated Gradient Mesh');
	menu.AppendMenuItem(MF_SEPARATOR, 0, '');
	menu.AppendMenuItem(CFG.glow ? MF_CHECKED : MF_STRING, 10, 'Glow Effect on Active Lyrics');
	menu.AppendMenuItem(CFG.rightAlignBacking ? MF_CHECKED : MF_STRING, 11, 'Right-align Backing Vocals (...)');

	var fontList = [];
	if (canSub) {
		menu.AppendMenuItem(MF_SEPARATOR, 0, '');

		// Line spacing
		var gapMenu = window.CreatePopupMenu();
		for (i = 0; i < MENU_GAPS.length; i++) {
			gapMenu.AppendMenuItem(CFG.lineGap === MENU_GAPS[i][1] ? MF_CHECKED : MF_STRING, 100 + i,
				MENU_GAPS[i][0] + ' (' + MENU_GAPS[i][1] + ' px)');
		}
		gapMenu.AppendMenuItem(MF_SEPARATOR, 0, '');
		gapMenu.AppendMenuItem(MF_STRING, 110, 'Increase (+2 px)');
		gapMenu.AppendMenuItem(MF_STRING, 111, 'Decrease (-2 px)');
		gapMenu.AppendTo(menu, MF_STRING, 'Line Spacing (' + CFG.lineGap + ' px)');

		// Text size
		var sizeMenu = window.CreatePopupMenu();
		for (i = 0; i < MENU_SIZES.length; i++) {
			sizeMenu.AppendMenuItem(Math.abs(CFG.fontScale - MENU_SIZES[i][1]) < 0.001 ? MF_CHECKED : MF_STRING, 120 + i, MENU_SIZES[i][0]);
		}
		sizeMenu.AppendTo(menu, MF_STRING, 'Text Size');

		// Font selection
		var fontMenu = window.CreatePopupMenu();
		fontMenu.AppendMenuItem(!CFG.fontFamily ? MF_CHECKED : MF_STRING, 200, 'Automatic (SF Pro Rounded / Inter / Segoe UI)');
		fontMenu.AppendMenuItem(MF_STRING, 201, 'Type a font name...');
		fontMenu.AppendMenuItem(MF_SEPARATOR, 0, '');
		fontList = listInstalledFonts();
		var groups = {}, order = [];
		for (i = 0; i < fontList.length; i++) {
			var ch = fontList[i].charAt(0).toUpperCase();
			if (!/[A-Z]/.test(ch)) ch = '#';
			if (!groups[ch]) { groups[ch] = []; order.push(ch); }
			groups[ch].push(i);
		}
		for (var g = 0; g < order.length; g++) {
			var sub = window.CreatePopupMenu();
			var idxs = groups[order[g]];
			for (var f = 0; f < idxs.length; f++) {
				sub.AppendMenuItem(fontList[idxs[f]] === CFG.fontFamily ? MF_CHECKED : MF_STRING, 1000 + idxs[f], fontList[idxs[f]]);
			}
			sub.AppendTo(fontMenu, MF_STRING, order[g]);
		}
		fontMenu.AppendTo(menu, MF_STRING, 'Font' + (CFG.fontFamily ? ' (' + CFG.fontFamily + ')' : ''));
	}

	var idx = menu.TrackPopupMenu(x, y);
	if (idx === 1) {
		setBackgroundMode(0);
	} else if (idx === 2) {
		setBackgroundMode(1);
	} else if (idx === 10) {
		CFG.glow = !CFG.glow;
		persistProp('Lyrics.Glow', CFG.glow);
		window.Repaint();
	} else if (idx === 11) {
		CFG.rightAlignBacking = !CFG.rightAlignBacking;
		persistProp('Lyrics.RightAlignBacking', CFG.rightAlignBacking);
		applyTypography();
	} else if (idx >= 100 && idx < 100 + MENU_GAPS.length) {
		CFG.lineGap = MENU_GAPS[idx - 100][1];
		persistProp('Lyrics.LineGap', CFG.lineGap);
		applyTypography();
	} else if (idx === 110 || idx === 111) {
		CFG.lineGap = clamp(CFG.lineGap + (idx === 110 ? 2 : -2), 0, 120);
		persistProp('Lyrics.LineGap', CFG.lineGap);
		applyTypography();
	} else if (idx >= 120 && idx < 120 + MENU_SIZES.length) {
		CFG.fontScale = MENU_SIZES[idx - 120][1];
		persistProp('Lyrics.FontScale', CFG.fontScale);
		applyTypography();
	} else if (idx === 200) {
		CFG.fontFamily = '';
		persistProp('Lyrics.FontFamily', '');
		applyTypography();
	} else if (idx === 201) {
		var typed = '';
		try {
			typed = String(utils.InputBox('Enter the exact name of an installed font (e.g. SF Pro, Yu Gothic UI, Poppins):', 'Lyrics Font', CFG.fontFamily || '', false) || '');
		} catch (eIn) { typed = ''; }
		typed = typed.replace(/^\s+|\s+$/g, '');
		if (typed && typed !== CFG.fontFamily) {
			var matched = resolveFontName(typed);
			if (fontExists(matched) || fontExists(typed)) {
				CFG.fontFamily = matched || typed;
				persistProp('Lyrics.FontFamily', CFG.fontFamily);
				applyTypography();
			} else if (has(utils, 'ShowPopupMessage')) {
				utils.ShowPopupMessage('Font "' + typed + '" is not recognized by foobar2000.\n\nIf you just installed this font while foobar2000 was running, please restart foobar2000 so DirectWrite can load newly installed fonts.', 'Lyrics Font');
			}
		}
	} else if (idx >= 1000 && idx - 1000 < fontList.length) {
		CFG.fontFamily = fontList[idx - 1000];
		persistProp('Lyrics.FontFamily', CFG.fontFamily);
		applyTypography();
	}

	return true;
}

// Initialization
(function init() {
	if (typeof window.GetProperty !== 'undefined') {
		CFG.bg.mode = window.GetProperty('Lyrics.Background.Mode', CFG.bg.mode);
		CFG.glow = window.GetProperty('Lyrics.Glow', CFG.glow);
		var pRight = window.GetProperty('Lyrics.RightAlignBacking', CFG.rightAlignBacking);
		if (typeof pRight !== 'undefined') CFG.rightAlignBacking = !!pRight;
		var pGap = Number(window.GetProperty('Lyrics.LineGap', CFG.lineGap));
		if (isFinite(pGap) && pGap >= 0 && pGap <= 120) CFG.lineGap = pGap;
		var pScale = Number(window.GetProperty('Lyrics.FontScale', CFG.fontScale));
		if (isFinite(pScale) && pScale >= 0.5 && pScale <= 2) CFG.fontScale = pScale;
		CFG.fontFamily = String(window.GetProperty('Lyrics.FontFamily', CFG.fontFamily) || '');
	}
	S.W = window.Width; S.H = window.Height;
	if (S.W && S.H) { relayout(true); bgResize(); }
	if (fb.IsPlaying) loadTrack(fb.GetNowPlaying());
})();
