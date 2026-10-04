'use strict';
/**
 * Smoke test: loads main.js into a vm sandbox with stubbed foobar2000 / JSP3 Direct2D objects.
 * Run: node test/smoke.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.join(__dirname, '..');
const code = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const samples = n => fs.readFileSync(path.join(root, 'samples', n), 'utf8');

function makeGr(log) {
	const rec = n => (...a) => { log.push([n, ...a]); };
	return {
		WriteText: rec('WriteText'),
		FillRectangle: rec('FillRectangle'),
		FillEllipse: rec('FillEllipse'),
		DrawRectangle: rec('DrawRectangle'),
		DrawImage: rec('DrawImage'),
		Clear: rec('Clear')
	};
}

function makeSandbox(files) {
	const timers = new Map();
	let nextId = 1, repaints = 0;
	const state = { playing: false, paused: false, time: 0, seeks: [] };
	const gr = makeGr([]);
	const img = {
		Width: 32, Height: 32,
		GetGraphics: () => gr,
		ReleaseGraphics() {},
		StackBlur() {},
		Resize() { return img; },
		Dispose() {},
		Clone() { return img; },
		GetColourSchemeJSON: () => JSON.stringify([
			{ colour: 0xFF3366CC | 0, count: 100 },
			{ colour: 0xFFCC3366 | 0, count: 80 },
			{ colour: 0xFF33CC66 | 0, count: 60 }
		]),
		GetColourScheme: () => ({
			toArray: () => [0xFF3366CC | 0, 0xFFCC3366 | 0, 0xFF33CC66 | 0]
		})
	};
	const sb = {
		window: {
			Width: 800, Height: 600, DPI: 96,
			Repaint() { repaints++; },
			SetInterval(fn, ms) { const id = nextId++; timers.set(id, { fn, ms }); return id; },
			ClearInterval(id) { timers.delete(id); },
			SetCursor() {},
			GetProperty(name, def) { return def; },
			SetProperty() {},
			CreatePopupMenu() {
				return {
					AppendMenuItem() {},
					AppendMenuSeparator() {},
					AppendTo() {},
					TrackPopupMenu() { return 0; }
				};
			}
		},
		utils: {
			CheckFont: n => n === 'Segoe UI',
			IsFile: p => Object.prototype.hasOwnProperty.call(files, p),
			ReadTextFile: p => files[p] || '',
			CreateImage: () => img,
			CalcTextWidth: (text, font, size) => String(text).length * 8,
			CreateTextLayout: (text, font, size) => ({
				CalcTextHeight: () => 24,
				CalcTextWidth: () => String(text).length * 8
			})
		},
		fb: {
			ProfilePath: 'C:\\profile\\',
			get IsPlaying() { return state.playing; },
			get IsPaused() { return state.paused; },
			get PlaybackTime() { return state.time; },
			set PlaybackTime(v) { state.time = v; state.seeks.push(v); },
			PlaybackLength: 60,
			GetNowPlaying: () => sb.meta,
			TitleFormat: expr => ({
				EvalWithMetadb: () => {
					if (expr.indexOf('lyrics') >= 0) return files.__tag || '';
					if (expr === '%artist%') return 'Artist';
					if (expr === '%title%') return 'Title';
					if (expr === '%album%') return 'Album';
					if (expr === '%filename%') return 'song';
					if (expr === '%path%') return 'C:\\music\\song.flac';
					if (expr === '$directory_path(%path%)') return 'C:\\music';
					return 'Album';
				}
			})
		},
		meta: {
			Path: 'C:\\music\\song.flac',
			RawPath: 'file://C:\\music\\song.flac',
			GetAlbumArt: () => ({ Image: img, Path: 'C:\\music\\song.flac' }),
			GetAlbumArtEmbedded: () => img,
			GetAlbumArtAsync() {},
			Compare: other => other === sb.meta
		},
		console
	};
	sb.__timers = timers; sb.__state = state; sb.__repaints = () => repaints; sb.__gr = gr;
	return sb;
}

function run(sb) {
	const ctx = vm.createContext(sb);
	vm.runInContext(code, ctx, { filename: 'main.js' });
	return ctx;
}

const ev = (ctx, expr) => vm.runInContext(expr, ctx);

// Parser tests
{
	const ctx = run(makeSandbox({}));
	ctx.__w = samples('word.lrc'); ctx.__l = samples('line.lrc'); ctx.__p = samples('plain.txt');

	const w = ev(ctx, 'parseLyrics(__w)');
	assert.strictEqual(w.mode, 3, 'word mode');
	assert.strictEqual(w.lines.length, 5, 'word lines (gap kept)');
	assert.strictEqual(w.lines[0].words.length, 5);
	assert.strictEqual(w.lines[0].words[4].endTime, 7.2, 'explicit trailing end');
	assert.strictEqual(w.lines[0].words[0].text, 'First ');
	assert.ok(w.lines[1].words[3].text === 'with ' && w.lines[1].words[4].text === 'syl');
	assert.ok(w.lines[2].isGap && w.lines[2].endTime === 18);
	assert.ok(!w.lines[4].timed, 'untagged line inside word file');
	assert.strictEqual(w.lines[0].endTime, 8);

	const l = ev(ctx, 'parseLyrics(__l)');
	assert.strictEqual(l.mode, 2, 'line mode');
	assert.strictEqual(l.lines.filter(x => x.text === 'Repeated chorus placeholder').length, 2);
	assert.ok(l.lines.some(x => x.isGap), 'gap kept');
	assert.ok(l.lines.every((x, i, a) => !i || a[i - 1].startTime <= x.startTime), 'sorted');

	const p = ev(ctx, 'parsePlain.call(null, __p.split("\\n"))');
	assert.strictEqual(p.mode, 1, 'plain mode');
	assert.strictEqual(ev(ctx, 'parseLyrics(__p)').mode, 1);
	assert.ok(p.lines.some(x => x.blank), 'paragraph break');

	assert.strictEqual(ev(ctx, 'parseLyrics("")').mode, 0);
	assert.strictEqual(ev(ctx, 'parseLyrics("[ar:x]\\n[ti:y]")').mode, 0);

	// offset: positive => earlier
	ctx.__o = '[offset:+500]\n[00:10.00]Line one\n[00:12.00]Line two';
	assert.strictEqual(ev(ctx, 'parseLyrics(__o)').lines[0].startTime, 9.5);

	// CJK tokenizing + wrap units
	ctx.__c = '[00:01.00]\u3053\u3093\u306b\u3061\u306f hello';
	// Japanese LRC (jp.lrc) test
	ctx.__jp = samples('jp.lrc');
	const jp = ev(ctx, 'parseLyrics(__jp)');
	ctx.__parsedJp = jp;
	assert.strictEqual(jp.mode, 3, 'jp word mode');
	assert.strictEqual(jp.lines[1].words.length, 2, 'jp line 1 keeps whole words rather than splitting into letters');
	assert.ok(jp.lines[1].words[0].text.indexOf('初めから') >= 0, 'jp line 1 first word text intact');
	// test layout of jp line 1 on narrow panel (maxW = 200)
	ev(ctx, 'layoutLine(__parsedJp.lines[1], 1, 200)');
	assert.ok(jp.lines[1].rows[1].length > 1, 'jp wraps into multiple rows');
	// Kinsoku Shori: ensure no row starts with non-starting punctuation / small kana
	const rows = jp.lines[1].rows[1];
	for (let i = 0; i < rows.length; i++) {
		const r = rows[i];
		assert.ok(!/^[、。，．・：；？！）〕］｝〉》」』】”’ーヽヾゝゞ々ァィゥェォッャュョヮヵヶぁぃぅぇぉっゃゅょゎ]/.test(r), 'Kinsoku Shori violated on row: ' + r);
	}
	console.log('parser OK');
}

// Integration (WORD mode)
function integration(label, file, expectedMode) {
	const sb = makeSandbox({ 'C:\\music\\song.lrc': file });
	const ctx = run(sb);
	sb.__state.playing = true;
	ctx.on_playback_new_track(sb.meta);
	assert.strictEqual(ev(ctx, 'S.mode'), expectedMode, label + ' mode');
	assert.ok(sb.__timers.size === 1, label + ' timer running');

	const log = [];
	const g = makeGr(log);
	ctx.on_paint(g);
	assert.ok(log.some(c => c[0] === 'WriteText'), label + ' draws text via DirectWrite');
	assert.ok(ev(ctx, 'Bg.hasArt'), label + ' has cover art from embedded FLAC');
	assert.ok(log.some(c => c[0] === 'DrawImage'), label + ' draws blurred background cover image');

	// Test background mode switching (Key 'B' / setBackgroundMode)
	assert.strictEqual(ev(ctx, 'CFG.bg.mode'), 0, label + ' initial bg mode is cover');
	ctx.on_key_down(66); // Press 'B'
	assert.strictEqual(ev(ctx, 'CFG.bg.mode'), 1, label + ' switched to gradient mode');
	log.length = 0;
	ctx.on_paint(g);
	assert.ok(log.some(c => c[0] === 'DrawImage'), label + ' gradient mode renders canvas');
	ctx.on_key_down(66); // Press 'B' again
	assert.strictEqual(ev(ctx, 'CFG.bg.mode'), 0, label + ' switched back to cover mode');

	// Test right-click context menu
	assert.strictEqual(ctx.on_mouse_rbtn_up(100, 100), true, label + ' context menu handled');

	// Test async embedded art callback
	ctx.on_get_album_art_done(sb.meta, 0, { Image: sb.utils.CreateImage(), Path: 'C:\\music\\song.flac' });
	assert.ok(ev(ctx, 'Bg.hasArt'), label + ' async embedded art applied');

	let maxMs = 0;
	let sawActiveWordZoom = false;
	for (let t = 0; t < 30; t += 0.25) {
		sb.__state.time = t;
		for (const { fn, ms } of sb.__timers.values()) { maxMs = Math.max(maxMs, ms); fn(); }
		log.length = 0;
		ctx.on_paint(g);
		if (expectedMode === 3) {
			const bigFont = ev(ctx, 'Fonts.str[2]');
			if (log.some(c => c[0] === 'WriteText' && c[2] === bigFont)) {
				sawActiveWordZoom = true;
			}
		}
	}
	if (expectedMode === 3) {
		assert.ok(sawActiveWordZoom, label + ' whole active word zoomed with Fonts.str[2]');
	}
	if (expectedMode > 1) {
		const act = ev(ctx, 'S.active');
		assert.ok(act >= 0, label + ' active line advances');
		ctx.on_mouse_lbtn_down(50, ev(ctx, 'S.lines[0].y') + 5);
		ctx.on_mouse_lbtn_up(50, ev(ctx, 'S.lines[0].y') + 5);
		assert.ok(sb.__state.seeks.length >= 1, label + ' click seeks');
	}
	ctx.on_mouse_wheel(-1);
	assert.ok(ev(ctx, 'S.manual'), label + ' wheel sets manual');

	sb.__state.paused = true;
	ctx.on_playback_pause(true);
	// settle every animation, timers should stop for PLAIN/paused-settled
	for (let i = 0; i < 400 && sb.__timers.size; i++) for (const { fn } of sb.__timers.values()) { fn(); break; }
	ctx.on_playback_stop(0);
	assert.strictEqual(sb.__timers.size, 0, label + ' no timer after stop');
	console.log(label + ' OK (max timer ' + maxMs + 'ms)');
}

integration('WORD ', samples('word.lrc'), 3);
integration('JP   ', samples('jp.lrc'), 3);
integration('LINE ', samples('line.lrc'), 2);
integration('PLAIN', samples('plain.txt'), 1);
integration('ROMA ', samples('with-romanized.lrc'), 2);
integration('JANNA', samples('4_Jannabi_May_the_TENDERNESS_be_with_you_feat_KARINA_of_a_WUD.lrc'), 2);

// Backing vocal right-alignment
{
	const jannaSrc = samples('4_Jannabi_May_the_TENDERNESS_be_with_you_feat_KARINA_of_a_WUD.lrc');
	const sb = makeSandbox({ 'C:\\music\\song.lrc': jannaSrc });
	const props = {};
	sb.window.SetProperty = (k, v) => { props[k] = v; };
	sb.window.GetProperty = (k, d) => (k in props ? props[k] : d);
	let menuPick = 0;
	sb.window.CreatePopupMenu = () => ({
		AppendMenuItem() {}, AppendMenuSeparator() {}, AppendTo() {},
		TrackPopupMenu() { return menuPick; }
	});

	const ctx = run(sb);
	sb.__state.playing = true;
	ctx.on_playback_new_track(sb.meta);

	const parsed = ev(ctx, 'S.lines');
	const backingLines = parsed.filter(l => l.text.indexOf('(어디든)') >= 0);
	assert.ok(backingLines.length >= 1, 'found (어디든) line');
	assert.strictEqual(backingLines[0].alignRight, true, 'standalone (어디든) has alignRight = true');

	const normalLines = parsed.filter(l => l.text.indexOf('사랑의 이름으로 (to you)') >= 0);
	assert.ok(normalLines.length >= 1, 'found inline parens line');
	assert.strictEqual(normalLines[0].alignRight, false, 'inline parens line has alignRight = false');

	// Verify paint passes DWRITE_TEXT_ALIGNMENT_TRAILING (1) for backing and LEADING (0) for normal
	const log = [];
	const g = makeGr(log);
	ctx.on_paint(g);
	const writeBacking = log.find(c => c[0] === 'WriteText' && c[1].indexOf('(어디든)') >= 0);
	const writeNormal = log.find(c => c[0] === 'WriteText' && c[1].indexOf('단순함이라는 거') >= 0);
	assert.ok(writeBacking, 'rendered (어디든)');
	assert.ok(writeNormal, 'rendered normal line');
	assert.strictEqual(writeBacking[8], 1, '(어디든) rendered with DWRITE_TEXT_ALIGNMENT_TRAILING (1)');
	assert.strictEqual(writeNormal[8], 0, 'normal line rendered with DWRITE_TEXT_ALIGNMENT_LEADING (0)');

	// Test right-click menu toggle (id = 11)
	assert.strictEqual(ev(ctx, 'CFG.rightAlignBacking'), true);
	menuPick = 11;
	ctx.on_mouse_rbtn_up(10, 10);
	assert.strictEqual(ev(ctx, 'CFG.rightAlignBacking'), false, 'toggled to false');
	assert.strictEqual(props['Lyrics.RightAlignBacking'], false, 'persisted property false');

	log.length = 0;
	ctx.on_paint(g);
	const writeBackingDisabled = log.find(c => c[0] === 'WriteText' && c[1].indexOf('(어디든)') >= 0);
	assert.ok(writeBackingDisabled);
	assert.strictEqual(writeBackingDisabled[8], 0, 'when toggle is disabled, (어디든) aligns left (0)');

	// Toggle back on
	ctx.on_mouse_rbtn_up(10, 10);
	assert.strictEqual(ev(ctx, 'CFG.rightAlignBacking'), true, 'toggled back to true');

	console.log('standalone parentheses right-alignment OK');
}

// Embedded FLAC cover art regression
// Real JSP3: GetAlbumArt(id,false) returns null when fb2k hasn't resolved it; the art must still
// be obtained through metadb.GetAlbumArtEmbedded (NOT utils.GetAlbumArtEmbedded, which does not exist).
{
	const sb = makeSandbox({});
	const calls = { stubFlag: [], embedded: 0, async: 0 };
	sb.meta.GetAlbumArt = (id, stub) => { calls.stubFlag.push(stub); return null; };
	sb.meta.GetAlbumArtEmbedded = () => { calls.embedded++; return sb.utils.CreateImage(); };
	sb.meta.GetAlbumArtAsync = () => { calls.async++; };
	const ctx = run(sb);
	sb.__state.playing = true;
	ctx.on_playback_new_track(sb.meta);
	assert.ok(ev(ctx, 'Bg.hasArt'), 'embedded-only art applied');
	assert.ok(calls.embedded > 0, 'metadb.GetAlbumArtEmbedded used');
	assert.ok(calls.stubFlag.every(s => s === false), 'GetAlbumArt always called with want_stub=false');

	// when nothing is found synchronously, async request goes through metadb.GetAlbumArtAsync
	const sb2 = makeSandbox({});
	const c2 = { async: 0 };
	sb2.meta.GetAlbumArt = () => null;
	sb2.meta.GetAlbumArtEmbedded = () => null;
	sb2.meta.GetAlbumArtAsync = () => { c2.async++; };
	sb2.window.ID = 1;
	const ctx2 = run(sb2);
	ctx2.on_playback_new_track(sb2.meta);
	assert.ok(c2.async > 0, 'async art requested via metadb.GetAlbumArtAsync');
	ctx2.on_get_album_art_done(sb2.meta, 0, sb2.utils.CreateImage());
	assert.ok(ev(ctx2, 'Bg.hasArt'), 'on_get_album_art_done(handle, id, image) applies art');
	const curCols = ev(ctx2, 'currentColors()');
	assert.ok(Array.isArray(curCols) && curCols.length > 0, 'currentColors returns array');
	for (let i = 0; i < curCols.length; i++) {
		assert.ok(Array.isArray(curCols[i]) && curCols[i].length === 3, 'each color is [r, g, b]');
		assert.ok(!Number.isNaN(curCols[i][0]) && !Number.isNaN(curCols[i][1]) && !Number.isNaN(curCols[i][2]), 'no NaN in colors');
	}
	ctx2.on_playback_dynamic_info_track(1);
	console.log('embedded art OK');
}

// Typography menu options
{
	function menuTest(pick, setup) {
		const sb = makeSandbox({ 'C:\\music\\song.lrc': samples('word.lrc') });
		const props = {};
		sb.window.GetProperty = (n, d) => (n in props ? props[n] : d);
		sb.window.SetProperty = (n, v) => { props[n] = v; };
		sb.utils.CheckFont = n => ['Segoe UI', 'Poppins', 'Yu Gothic UI'].indexOf(n) >= 0;
		sb.utils.ListFonts = () => ['Yu Gothic UI', '@Vertical', 'Poppins', 'Arial', 'Poppins'];
		sb.window.CreatePopupMenu = () => ({
			AppendMenuItem() {}, AppendMenuSeparator() {}, AppendTo() {},
			TrackPopupMenu() { return pick; }
		});
		if (setup) setup(sb, props);
		const ctx = run(sb);
		sb.__state.playing = true;
		ctx.on_playback_new_track(sb.meta);
		return { sb, ctx, props };
	}
	const open = r => r.ctx.on_mouse_rbtn_up(10, 10);

	const base = menuTest(0);
	const h0 = ev(base.ctx, 'S.lines[0].h[0]');
	const fs0 = ev(base.ctx, 'Fonts.sizePx[1]');

	const gap = menuTest(103); open(gap); // Relaxed = 24 px
	assert.strictEqual(ev(gap.ctx, 'CFG.lineGap'), 24, 'relaxed gap applied');
	assert.strictEqual(gap.props['Lyrics.LineGap'], 24, 'gap persisted');
	assert.ok(ev(gap.ctx, 'S.lines[0].h[0]') > h0, 'bigger gap => taller lines');
	const dec = menuTest(111); open(dec);
	assert.strictEqual(ev(dec.ctx, 'CFG.lineGap'), 14, 'decrease by 2 px');

	const size = menuTest(123); open(size);
	assert.strictEqual(ev(size.ctx, 'CFG.fontScale'), 1.3, 'text size applied');
	assert.ok(ev(size.ctx, 'Fonts.sizePx[1]') > fs0, 'larger fonts rebuilt');

	// sorted + de-duplicated list, "@" vertical fonts hidden: Arial=0, Poppins=1, Yu Gothic UI=2
	const pick = menuTest(1001); open(pick);
	assert.strictEqual(ev(pick.ctx, 'CFG.fontFamily'), 'Poppins', 'installed font chosen');
	assert.strictEqual(ev(pick.ctx, 'Fonts.face'), 'Poppins', 'font face rebuilt');
	assert.strictEqual(pick.props['Lyrics.FontFamily'], 'Poppins', 'font persisted');

	const typed = menuTest(201, sb => { sb.utils.InputBox = () => 'Yu Gothic UI'; }); open(typed);
	assert.strictEqual(ev(typed.ctx, 'Fonts.face'), 'Yu Gothic UI', 'typed font applied');
	const bad = menuTest(201, sb => { sb.utils.InputBox = () => 'NoSuchFont'; sb.utils.ShowPopupMessage = () => {}; }); open(bad);
	assert.strictEqual(ev(bad.ctx, 'CFG.fontFamily'), '', 'unknown font rejected');
	const auto = menuTest(200); open(auto);
	assert.strictEqual(ev(auto.ctx, 'CFG.fontFamily'), '', 'automatic font');

	const saved = { 'Lyrics.LineGap': 30, 'Lyrics.FontFamily': 'Poppins', 'Lyrics.FontScale': 1.15 };
	const restored = menuTest(0, (sb, props) => { for (const k in saved) props[k] = saved[k]; });
	assert.strictEqual(ev(restored.ctx, 'CFG.lineGap'), 30, 'gap restored');
	assert.strictEqual(ev(restored.ctx, 'Fonts.face'), 'Poppins', 'font restored');
	console.log('typography menu OK');
}

// Word transition smoothness
{
	const sb = makeSandbox({ 'C:\\music\\song.lrc': samples('word.lrc') });
	const ctx = run(sb);
	sb.__state.playing = true;
	ctx.on_playback_new_track(sb.meta);

	const log = [];
	const g = makeGr(log);
	const tick = () => { for (const { fn } of sb.__timers.values()) fn(); };

	// First word in word.lrc is "First " at 5.00s -> 5.40s
	// Test at entering state (t = 5.02s)
	sb.__state.time = 5.02;
	tick();
	log.length = 0;
	ctx.on_paint(g);
	assert.ok(log.some(c => c[0] === 'WriteText'), 'entering word renders text');

	// Test at active state (t = 5.20s)
	sb.__state.time = 5.20;
	tick();
	log.length = 0;
	ctx.on_paint(g);
	const bigFont = ev(ctx, 'Fonts.str[2]');
	assert.ok(log.some(c => c[0] === 'WriteText' && c[2] === bigFont), 'active word renders with enlarged font');

	// Test at settling state (t = 5.44s, 40ms after end)
	sb.__state.time = 5.44;
	tick();
	log.length = 0;
	ctx.on_paint(g);
	assert.ok(log.some(c => c[0] === 'WriteText' && c[2] === bigFont), 'settling word renders with smooth landing glide');

	// Test at settled state (t = 5.70s, 300ms after end)
	sb.__state.time = 5.70;
	tick();
	log.length = 0;
	ctx.on_paint(g);
	assert.ok(log.some(c => c[0] === 'WriteText'), 'settled word renders in solid played state');
	console.log('word transition smoothness OK');
}

// FLAC embedded art and cache fallback
{
	const cachedArtPath = 'C:\\profile\\artwork\\a1b2c3d4.jpg';
	const files = {
		'C:\\music\\song.lrc': samples('word.lrc'),
		[cachedArtPath]: 'fake_cached_image_data'
	};
	const sb = makeSandbox(files);
	// Simulate metadb.GetAlbumArt returning null (as when fb2k is still reading the FLAC stream)
	sb.meta.GetAlbumArt = () => null;
	sb.meta.GetAlbumArtEmbedded = () => null;
	// Add utils.GetAlbumArtEmbedded
	let embeddedCalled = false;
	sb.utils.GetAlbumArtEmbedded = (target, type) => {
		embeddedCalled = true;
		return { Image: sb.utils.CreateImage(), Path: 'embedded' };
	};
	sb.utils.LoadImage = p => {
		if (p === cachedArtPath) return { Image: sb.utils.CreateImage(), Path: p };
		return null;
	};

	const ctx = run(sb);
	sb.__state.playing = true;
	ctx.on_playback_new_track(sb.meta);
	assert.ok(embeddedCalled, 'utils.GetAlbumArtEmbedded called as fallback');
	assert.ok(ev(ctx, 'Bg.hasArt'), 'embedded art loaded from FLAC metadata');

	// Test cached image_path in on_get_album_art_done
	ev(ctx, 'setCoverArt(null, null)');
	assert.strictEqual(ev(ctx, 'Bg.hasArt'), false);
	ctx.on_get_album_art_done(sb.meta, 0, null, cachedArtPath);
	assert.ok(ev(ctx, 'Bg.hasArt'), 'artwork loaded from foobar2000 cache path via utils.LoadImage');

	console.log('FLAC embedded art fallbacks OK');
}

// Search patterns and directory scan
{
	const files = {
		'C:\\music\\song.lrc': samples('word.lrc'),
		'C:\\music\\song.jpg': 'fake_image_matching_filename'
	};
	const sb = makeSandbox(files);
	sb.meta.GetAlbumArt = () => null;
	sb.utils.GetAlbumArtEmbedded = () => null;
	sb.utils.ListFiles = dir => {
		if (dir === 'C:\\music') return ['C:\\music\\song.flac', 'C:\\music\\song.lrc', 'C:\\music\\song.jpg'];
		return [];
	};
	sb.utils.LoadImage = p => {
		if (p === 'C:\\music\\song.jpg') return { Image: sb.utils.CreateImage(), Path: p };
		return null;
	};

	const ctx = run(sb);
	sb.__state.playing = true;
	ctx.on_playback_new_track(sb.meta);
	assert.ok(ev(ctx, 'Bg.hasArt'), 'loaded artwork matching foobar2000 %filename%.* pattern via utils.ListFiles');

	// Test unwrapImage with direct string path (prevent regression of string character recursion)
	const unwrapped = ev(ctx, 'unwrapImage("C:\\\\music\\\\song.jpg")');
	assert.ok(unwrapped, 'unwrapImage correctly loads direct string path');

	console.log('Foobar2000 search patterns & unwrapImage string handling OK');
}

// Bilingual and romanized lyrics pairing
{
	const sb = makeSandbox({ 'C:\\music\\song.lrc': samples('with-romanized.lrc') });
	const ctx = run(sb);
	sb.__state.playing = true;
	ctx.on_playback_new_track(sb.meta);

	const parsed = ev(ctx, 'S.lines');
	assert.strictEqual(parsed.length, 48, '48 lines total (46 bilingual lines + 2 instrumental gaps)');
	assert.strictEqual(parsed[0].text, '何にも役に立たないことばかり');
	assert.strictEqual(parsed[0].sub.length, 1);
	assert.strictEqual(parsed[0].sub[0], 'Nanni mo yaku ni tatanai koto bakari');
	assert.strictEqual(parsed[0].startTime, 5.88);
	assert.strictEqual(parsed[0].endTime, 9.73);

	// Check layout of romanized sub-lines
	assert.ok(parsed[0].subRows[0].length >= 1, 'subRows[0] populated for inactive font');
	assert.ok(parsed[0].subRows[1].length >= 1, 'subRows[1] populated for active font');
	assert.ok(parsed[0].h[0] > ev(ctx, 'Fonts.rowH[0] + CFG.lineGap * S.scale'), 'line height includes sub-line');

	// Rendering test at t = 6.0s (Line 0 active)
	sb.__state.time = 6.0;
	for (const { fn } of sb.__timers.values()) fn();
	const log = [];
	const g = makeGr(log);
	ctx.on_paint(g);

	// Verify both primary Japanese text and Romanized text are drawn
	const drewJp = log.some(c => c[0] === 'WriteText' && c[1] === '何にも役に立たないことばかり');
	const drewRomaji = log.some(c => c[0] === 'WriteText' && c[1].indexOf('Nanni mo yaku ni tatanai') >= 0);
	assert.ok(drewJp, 'drawn active primary Japanese line');
	assert.ok(drewRomaji, 'drawn active Romanized sub-line');

	// Verify active sub-line uses active sub font Fonts.subStr[1]
	const activeSubFont = ev(ctx, 'Fonts.subStr[1]');
	assert.ok(log.some(c => c[0] === 'WriteText' && c[2] === activeSubFont), 'active sub-line rendered with Fonts.subStr[1]');

	// Test click-to-seek on the romanized sub-line area of line 0
	const line0Y = ev(ctx, 'S.lines[0].y');
	const subClickY = line0Y + ev(ctx, 'S.lines[0].rows[1].length * Fonts.rowH[1] + 6');
	sb.__state.seeks.length = 0;
	ctx.on_mouse_lbtn_down(50, subClickY);
	ctx.on_mouse_lbtn_up(50, subClickY);
	assert.strictEqual(sb.__state.seeks.length, 1, 'clicking romanized sub-line triggers seek');
	assert.strictEqual(sb.__state.seeks[0], 5.88, 'seeks to line 0 timestamp (5.88s)');

	// Duplicate timestamp test: identical text at same timestamp is ignored, not added to sub
	ctx.__dup = '[00:01.00] Hello world\n[00:01.00] Hello world\n[00:03.00] Next';
	const parsedDup = ev(ctx, 'parseLyrics(__dup)');
	assert.strictEqual(parsedDup.lines.length, 2, 'duplicate line ignored');
	assert.strictEqual(parsedDup.lines[0].sub.length, 0, 'sub is empty for duplicate');

	console.log('Bilingual & romanized lyrics pairing OK');
}

console.log('ALL OK');


