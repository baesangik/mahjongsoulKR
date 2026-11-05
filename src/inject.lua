-- [mjs-kr] injected at the end of GameMgr.lua by the userscript.
-- Shows text in Korean on the JP client: client_language (region/server) stays jp,
-- only prefer_language (display) becomes kr. Any failure falls back to Japanese.
do
  local TAG = '[mjs-kr] '
  local function log(m) pcall(print, TAG .. tostring(m)) end
  local pk = table.unpack or unpack
  local function pack(...) return { n = select('#', ...), ... } end

  local KR = (ELangStr and ELangStr.Kr) or 'kr'
  local JP = (ELangStr and ELangStr.Jp) or 'jp'
  local font_ok = false

  local function set_lang(l)
    if GameMgr.Inst then GameMgr.Inst.prefer_language = l end
    if LangMgr then
      LangMgr.prefer_language = l
      LangMgr.is_cn_lang = false
      LangMgr.is_alphabet_lang = (l == KR)
    end
  end

  local function apply()
    if not (font_ok and GameMgr.Inst and LangMgr) then set_lang(JP); return end
    if GameMgr.Inst.client_language ~= JP then
      log('client_language=' .. tostring(GameMgr.Inst.client_language) .. ', not touching')
      return
    end
    set_lang(KR)
  end

  local function wrap(tbl, name, fn)
    local orig = tbl and tbl[name]
    if type(orig) ~= 'function' then log('missing ' .. name); return end
    tbl[name] = function(...) return fn(orig, ...) end
  end

  -- Load the Korean font group before GameMgr initialises (JP build never loads it).
  local started = false
  wrap(GameMgr, 'Init', function(orig, self, ...)
    if started then return orig(self, ...) end
    started = true
    local args = pack(...)
    local resumed = false
    local function resume()
      if resumed then return end
      resumed = true
      local ok, f = pcall(function() return LuaTools.LoadFont('kr/kr.ttf') end)
      font_ok = ok and f ~= nil
      log(font_ok and 'fonts/kr ready' or ('fonts/kr unavailable: ' .. tostring(f)))
      return orig(self, pk(args, 1, args.n))
    end
    local ok, err = pcall(function() LuaTools.LoadGroup('fonts/kr', resume, nil) end)
    if not ok then log('LoadGroup failed: ' .. tostring(err)); return resume() end
  end)

  wrap(LangMgr, 'Init', function(orig, ...)
    local r = pack(orig(...))
    local ok, err = pcall(apply)
    if not ok then pcall(set_lang, JP); log('apply failed: ' .. tostring(err)) end
    log('prefer_language=' .. tostring(GameMgr.Inst and GameMgr.Inst.prefer_language))
    return pk(r, 1, r.n)
  end)

  -- GameMgr:OnInit copies GamePlatformInfo.prefer_language back; reapply before UI setup.
  wrap(UIMgr, 'Init', function(orig, ...)
    local ok, err = pcall(apply)
    if not ok then pcall(set_lang, JP); log('apply failed: ' .. tostring(err)) end
    return orig(...)
  end)

  log('hooks installed')
end
