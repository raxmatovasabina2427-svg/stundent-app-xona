// Plaginlar: src/plugins/<nom>/ papkalarini topadi va ilovaga ulaydi.
//  - index.js        -> { name, title, router, nav }
//  - views/<nom>/    -> res.render('<nom>/sahifa') orqali
//  - public/         -> brauzerda /p/<nom>/...
//  - migrations/     -> NNN_*.sql (asosiy migratsiyalardan keyin, tranzaksiyada)
// "_" bilan boshlangan papkalar (masalan _namuna) yuklanmaydi.
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const DIR = path.join(__dirname, '../plugins');
const NAME_RE = /^[a-z][a-z0-9_]*$/;

/** Plagin papkalari (index.js'ni yuklamasdan) */
function pluginDirs() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort()
    .map((name) => {
      if (!NAME_RE.test(name)) throw new Error(`Plagin papkasi nomi noto'g'ri: ${name}`);
      return { name, dir: path.join(DIR, name) };
    })
    .filter((p) => fs.existsSync(path.join(p.dir, 'index.js')));
}

/** Plagin migratsiya fayllari: version = "<plagin>/001_init" */
function pluginMigrationFiles() {
  const out = [];
  for (const { name, dir } of pluginDirs()) {
    const mdir = path.join(dir, 'migrations');
    if (!fs.existsSync(mdir)) continue;
    for (const f of fs.readdirSync(mdir).filter((x) => /^\d{3}_.+\.sql$/.test(x)).sort()) {
      out.push({ version: `${name}/${f.replace(/\.sql$/, '')}`, file: path.join(mdir, f), label: `${name}/${f}` });
    }
  }
  return out;
}

let loaded = null;
function loadPlugins() {
  if (loaded) return loaded;
  loaded = pluginDirs().map(({ name, dir }) => {
    const mod = require(dir);
    if (mod.name !== name) throw new Error(`Plagin "${name}": index.js dagi name ("${mod.name}") papka nomiga teng bo'lishi kerak`);
    if (!mod.router) throw new Error(`Plagin "${name}": router yo'q`);
    return { ...mod, dir, nav: Array.isArray(mod.nav) ? mod.nav : [] };
  });
  return loaded;
}

/** Menyu: res.locals.pluginNav = rolga mos havolalar */
function pluginLocals() {
  const plugins = loadPlugins();
  return (req, res, next) => {
    const role = req.user && req.user.role;
    const items = [];
    for (const p of plugins) {
      for (const n of p.nav) {
        if (n.roles && !n.roles.includes(role)) continue;
        const on = req.path === n.href || req.path.startsWith(`${n.href}/`);
        items.push({ href: n.href, label: n.label, on });
      }
    }
    res.locals.pluginNav = items;
    next();
  };
}

/** Plagin view'lari, statik fayllari va marshrutlarini ulaydi */
function mountPlugins(app) {
  const plugins = loadPlugins();
  const viewRoots = new Map(plugins.map((p) => [p.name, path.join(p.dir, 'views')]));

  // res.render('<plagin>/sahifa') -> plagin views papkasidan (absolyut yo'l bilan)
  app.use((req, res, next) => {
    const render = res.render.bind(res);
    res.render = (view, ...args) => {
      if (typeof view === 'string') {
        const root = viewRoots.get(view.split('/')[0]);
        if (root) view = path.join(root, view);
      }
      return render(view, ...args);
    };
    next();
  });

  for (const p of plugins) {
    const pub = path.join(p.dir, 'public');
    if (fs.existsSync(pub)) app.use(`/p/${p.name}`, express.static(pub));
    app.use(p.router);
  }
  return plugins;
}

module.exports = { pluginDirs, pluginMigrationFiles, loadPlugins, pluginLocals, mountPlugins };
