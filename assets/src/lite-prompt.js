// lite（精简模式）的提示词构造与输出解析。
// 从 bridge.js 拆出：原来这 5 个函数是 main() 里的闭包，靠外部变量通信；
// 现在改为参数注入，模块本身不读 config、不碰全局状态。
import fs from 'node:fs';
import path from 'node:path';

export function createLitePrompt(deps) {
  const {
    cfg, STATE_DIR, log,
    getSocialV2State, getStickerEntries,
    nicknameOf,
    describeLiking, detectThread,
    recallColdStorage, triggerWantsRecall,
    currentRoleHintV2, songsHint, ttsCfg,
    likingData, LITE_SYSTEM_TEMPLATE, ROLE_MAX_CHARS,
  } = deps;

  // bridge.js 会重新赋值 stickerEntries；通过透明数组代理保留原闭包的实时读取语义。
  const stickerEntries = new Proxy([], {
    get(_target, property) {
      const current = getStickerEntries();
      const value = Reflect.get(current, property, current);
      return typeof value === 'function' ? value.bind(current) : value;
    }
  });

  function liteConfig() {
    const l = cfg.socialV2?.lite ?? {};
    return {
      enabled: l.enabled === true,
      baseUrl: String(l.baseUrl || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
      apiKey: String(l.apiKey || process.env.DEEPSEEK_API_KEY || ''),
      model: String(l.model || 'deepseek-chat'),
      recentLimit: Math.max(0, Math.min(100, Number(l.recentLimit) || 30)),
      maxTokens: Math.max(200, Math.min(4000, Number(l.maxTokens) || 1200)),
      timeoutMs: Math.max(5000, Math.min(120000, Number(l.timeoutMs) || 30000)),
      stickerHints: Math.max(0, Math.min(120, Number(l.stickerHints) || 60))
    };
  }

  function buildLiteSystemPrompt() {
    const lc = liteConfig();
    const role = String(currentRoleHintV2() ?? '').trim() || '你是一只叫「大肥鱼」的鲸鱼娘，说话短、有脾气。';
    const labels = [];
    const seen = new Set();
    for (const e of (Array.isArray(stickerEntries) ? stickerEntries : [])) {
      const note = String(e?.localNote ?? '').trim();
      if (!note || seen.has(note)) continue;
      seen.add(note);
      labels.push(note);
      if (labels.length >= lc.stickerHints) break;
    }
    const voiceOn = ttsCfg().enabled;
    const voiceField = voiceOn
      ? '  "voice": "想用语音说的一句话（10~40字，会单独发成一条语音，别和 reply 重复）",'
      : '';
    const voiceRules = voiceOn
      ? '- voice 要真的像开口说话：短、口语、有语气；想强调、吐槽、叫人的时候才用，两三轮回一次就够，别每轮都用。' +
        '\n- 语音和文字是两条消息：voice 说的话不要和 reply 重复，语音说完再打字补充。'
      : '';
    return LITE_SYSTEM_TEMPLATE
      .replace('{{ROLE}}', role.length > ROLE_MAX_CHARS
        ? (log('[role] 人格卡 ' + role.length + ' 字符，超过上限 ' + ROLE_MAX_CHARS + '，已截断尾部（请精简或调大 ROLE_MAX_CHARS）'),
           role.slice(0, ROLE_MAX_CHARS))
        : role)
      .replace('{{STICKERS}}', labels.length ? labels.join('、') : '（暂无）')
      .replace('{{VOICE_FIELD}}', voiceField)
      .replace('{{VOICE_RULES}}', voiceRules)
      .replace('{{SONGS}}', songsHint());
  }

  /** 拼本轮的用户消息：群里最近的消息 + 本次唤醒的快照。 */
  function buildLiteUserMessage(key, reason, snapshot, research = null, sweep = null, attachedSeqs = null, fwd = null) {
    const lc = liteConfig();
    const st = getSocialV2State(key);
    const parts = [];

    // 话头追踪（2026-10-26）：以前只注入「最后 20 条」，群里约 14 条/小时，
    // 一个话题聊过 1.5 小时，开头那几条（前因）就永远看不到了。
    // 现在先认出「这个话题从哪开始」，把窗口外的开头 + 中间最要紧的几句也带上。
    // 全程本地 bigram 计算，0 次 API；见 src/lite-thread.mjs。
    let thread = { active: false, rows: [], count: 0, startTime: '' };
    try {
      thread = detectThread(st.recentMessages, { recentLimit: lc.recentLimit });
    } catch (error) {
      log('[thread] 话头追踪失败（不影响这轮）: ' + (error?.message ?? error));
    }
    if (thread.active) {
      log('[thread] ' + key + ' 话头 ' + thread.count + ' 条，从 ' + thread.startTime + ' 起，补回 '
        + thread.rows.filter((r) => r.type === 'msg').length + ' 条（另标略过 ' + thread.skipped + ' 条）');
    }
    const recent = (Array.isArray(st.recentMessages) ? st.recentMessages : []).slice(-lc.recentLimit);
    const fresh = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
    const freshSeqs = new Set(fresh.map((m) => Number(m?.seq)).filter((n) => Number.isSafeInteger(n)));
    // unread 里超出 recent 窗口的旧消息补到最前面，避免「读不到」被静默吞掉。
    const recentSeqs = new Set(recent.map((m) => Number(m?.seq)).filter((n) => Number.isSafeInteger(n)));
    const extraUnread = fresh.filter((m) => Number.isSafeInteger(Number(m?.seq)) && !recentSeqs.has(Number(m.seq)));
    let list = [...extraUnread, ...recent];
    // 窗口外的前因按时间顺序插到最前面，中间用省略标记隔开
    if (thread.active && Array.isArray(thread.rows) && thread.rows.length) {
      // 包一层带 __old 标记：**不要直接改 r.m**，那是 recentMessages 里的对象引用，
      // 改了会把「这是旧消息」永久烙在真实消息上。
      const head = thread.rows.map((r) => (r.type === 'gap' ? { __gap: r.n } : { ...r.m, __old: true }));
      list = [...head, ...list];
    }
    if (list.length) {
      const headLine = key.startsWith('private:')
        ? '【你和 TA 的私聊】（旧 → 新；括号里是 QQ 号，「你」是你自己）'
        : '【群里最近的消息】（旧 → 新；括号里是 QQ 号，「你」是你自己）';
      parts.push(thread.active
        ? headLine.slice(0, -1) + `。**这个话题从 ${thread.startTime} 起已经聊了 ${thread.count} 条**。开头标「〔早先〕」的是几小时前的旧消息，只帮你回忆起这个话题是怎么起头的，**不要回头去回它们**；「……略」是中间跳过的部分）`
        : headLine);
      for (const m of list) {
        // 中间被省略的那一段：明说省略多少条，免得她以为中间没人说话
        if (m && m.__gap) {
          parts.push(`（……中间 ${m.__gap} 条略，还是同一件事的来回……）`);
          continue;
        }
        // 别人的消息必须带 QQ 号：模型要 @ 人只有这一个可靠依据，
        // 以前不给号码却要求它输出 at，结果就是 @ 错人（2026-10-21 实测）。
        // 昵称是「。」「?」这种单字符/纯标点时，模型会把它当标点而不是人名
        // （2026-10-23 实测：她 @ 了昵称叫「。」的群主，而图其实是「原文」发的）。
        // 这类昵称外面套书名号，模型才认得出这是一个人。
        const rawName = String(m.sender || '某人');
        const oddName = rawName.length <= 2 || !/[\p{L}\p{N}]/u.test(rawName);
        const nameShown = oddName && !m.isSelf ? '「' + rawName + '」' : rawName;
        const who = m.isSelf
          ? '你'
          : (m.userId ? `${nameShown}(${m.userId})` : nameShown);
        const text = String(m.text ?? '').replace(/\s+/g, ' ').slice(0, 160);
        const ownerTag = (!m.isSelf && m.isOwner) ? '【主人】' : '';
        const isNew = Number.isSafeInteger(Number(m.seq)) && freshSeqs.has(Number(m.seq));
        // 时间戳：她以前分不清「刚发的」和「半小时前的」，会把凉了的梗当新话题接
        // （2026-10-22 实测 19:47 那轮）。带上 HH:MM 她就能说出「这都半小时前的事了」。
        let ts = '';
        const mt = Number(m.time || 0);
        if (mt > 0) {
          const d2 = new Date(mt);
          ts = '[' + String(d2.getHours()).padStart(2, '0') + ':' + String(d2.getMinutes()).padStart(2, '0') + '] ';
        }
        // 引用关系：她得知道自己这句是在跟谁说话（群聊交错时最容易搞混）。
        const rel = m.quoteTargetIsSelf ? ' →回你' : '';
        // 带图的两条消息连着出现时，她分不清图是谁的（2026-10-26 实测）。这里明写
        // 「这张图附给你了没有」——没附的那条她看不到内容，就不该猜。
        let imgTag = '';
        if (m.hasMedia) {
          const mine = attachedSeqs && Number.isSafeInteger(Number(m.seq)) && attachedSeqs.has(Number(m.seq));
          imgTag = mine ? '［图已附给你］' : '［图没附给你，你看不到这条的图］';
        }
        // 捞回来的旧消息要和「现在正聊的」区分开（2026-10-26）：实测她会把两小时前的
        // 「我给你兜底」当成待回应的事，隔一会儿又问一遍「那个兜底还算不算数」。
        const oldTag = m && m.__old ? '〔早先〕' : '';
        parts.push(`${oldTag}${ts}${ownerTag}${who}：${text}${imgTag}${rel}${isNew ? '  ← 刚到的' : ''}`);
      }
      if (freshSeqs.size) {
        parts.push('');
        parts.push('带「← 刚到的」那几条就是你这轮要回的。不带标记的只是背景，别回头去回它们。');
      }
    }
    // 她以前完全不知道现在几点，所以从来不会说「这么晚了还不睡」「早」这类话 ——
    // 真人是有时间感的。放 user 消息里（不动 system 前缀，避免打掉 prompt cache）。
    try {
      const nowDate = new Date();
      const hh = nowDate.getHours();
      const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][nowDate.getDay()];
      const stage = hh < 6 ? '凌晨' : hh < 9 ? '早上' : hh < 12 ? '上午' : hh < 14 ? '中午'
        : hh < 18 ? '下午' : hh < 22 ? '晚上' : '深夜';
      parts.push(`【现在是】${wd} ${String(hh).padStart(2, '0')}:${String(nowDate.getMinutes()).padStart(2, '0')}（${stage}）`);
      if (hh >= 23 || hh < 6) parts.push('（这么晚还在群里，可以催一句早点睡，但不用每次都说）');
      else if (hh < 9) parts.push('（早上，语气可以轻快一点）');
    } catch {}
    const wakeUser = String(st.lastWakeUserId ?? '').trim();
    if (wakeUser) {
      parts.push(describeLiking(likingData(), wakeUser, nicknameOf(key, wakeUser)));
      parts.push('');
      // 明确「这次是谁把你叫醒的」（2026-10-26）。以前只给印象不给触发者，
      // 她分不清「谁在叫我」和「我在跟谁聊」，两次当成一回事就会 @ 错人。
      // 注意：**不要求 @ 回去** —— 拍一拍只是戳一下，接上文就行。
      try {
        const wn = nicknameOf(key, wakeUser) || wakeUser;
        const rs = String(reason || '');
        const why = rs === 'atMention' ? '在群里 @ 了你'
          : rs === 'nameMention' ? '叫了你的名字'
          : rs === 'poke' ? '拍了你一下（拍一拍，**没有附任何文字**）'
          : rs === 'question' ? '在群里问了个问题'
          : rs.startsWith('keyword') ? '你被关键词叫醒了'
          : rs === 'presence' ? '你刚回过话，群里接着说'
          : rs === 'timeout' ? '沉默了一会儿'
          : rs === 'proactiveCheck' ? '你自己想开口'
          : '';
        parts.push('【这次为什么醒】' + wn + '(' + wakeUser + ') ' + (why || rs));
        if (rs === 'poke') {
          parts.push('（拍一拍只是戳你一下，没有内容。你可以顺着群里正在聊的接一句、可以反问、也可以只吐槽被拍，'
            + '**不需要为了「回应他」专门 @ 他**；要 @ 谁，看你这句话实际在跟谁说。）');
        }
        // 一轮里可能有好几个人连着拍（2026-10-26 实测：「。」拍了两次还追问「宕机了？」，
        // 她只回了最后 @ 她的主人，把拍的人晾着）。把「这一轮拍过你的都有谁」全列出来。
        try {
          const freshMsgs = Array.isArray(snapshot && snapshot.messages) ? snapshot.messages : [];
          const pokers = [];
          for (const mm of freshMsgs) {
            if (!mm || mm.isSelf) continue;
            const tx = String(mm.text || '');
            if (!/拍一拍|拍了拍/.test(tx)) continue;
            if (!/你/.test(tx)) continue;
            const nm2 = String(mm.sender || '');
            if (nm2 && !pokers.includes(nm2)) pokers.push(nm2);
          }
          if (pokers.length > 1) {
            parts.push('（这一轮拍你的不止一个人：' + pokers.join('、') + '。要理就一起带一句，别只回最后一个。）');
          }
        } catch (e) { /* 忽略 */ }
        parts.push('');
      } catch (e) { /* 忽略 */ }
    }
    // 她记不住人以前的事 —— 现在把「打过交道的人」捞出来给她看（最多 6 条、30 天过期）。
    try {
      const imp = (st.memberImpressions && typeof st.memberImpressions === 'object') ? st.memberImpressions : {};
      const rows = Object.entries(imp)
        .filter(([, v]) => v && v.note && Date.now() - Number(v.at || 0) < 30 * 24 * 3600 * 1000)
        .sort((a, b) => Number(b[1].at || 0) - Number(a[1].at || 0))
        .slice(0, 6);
      if (rows.length) {
        parts.push('【你记得这几个人】');
        for (const [uid, v] of rows) parts.push(`- ${v.name || uid}(${uid})：${String(v.note).slice(0, 30)}`);
        parts.push('');
      }
    } catch {}
    // 冷存储往事检索（2026-10-25）：只有有人在问以前的事、提老梗时才查，平时一个字都不加。
    // 只读本地文件，0 次 API 调用；中文不分词，用 bigram + IDF 打分（见 src/lite-recall.mjs）。
    try {
      const recallTexts = [
        ...(Array.isArray(st.unread) ? st.unread : []),
        ...(Array.isArray(st.recentMessages) ? st.recentMessages : []),
      ]
        .slice(-6)
        .map((m) => String(m?.text ?? m?.plain ?? ''));
      // 2026-10-26：私聊里每轮都检索一次。
      // 原因：主人问「群里谁最喜欢喂你吃白饭啊」不含任何触发词（上次/以前/记得…），
      // 窄触发下她根本不去翻库，答得就像失忆。而检索全在本地跑、0 次 API 调用，
      // 私聊内容又只有他和她两个人，滥一点没有副作用。
      // 群聊仍然保持窄触发 —— 那里滥了会把无关片段塞进上下文、还容易串话题。
      let wantRecall = key.startsWith('private:') || triggerWantsRecall(recallTexts);
      // 话头已经长到超出窗口（聊很久 / 跨了天）→ 无条件翻一次库。
      // 否则「昨天聊到一半今天接着聊」她根本不去查，答得就像失忆（2026-10-26）。
      if (!wantRecall && thread.active && thread.count >= lc.recentLimit * 2) wantRecall = true;
      if (wantRecall) {
        // 2026-10-26：群聊和私聊共享记忆库 —— 两边都能翻到对方的记录。
        // 但**出口是单向的**：群聊里检索到的私聊内容会被打上「｜私聊」标记，
        // 并在提示词里明确「不许复述」。物理上仍然分目录存，不混写。
        const memRoot = path.join(STATE_DIR, 'memory');
        const selfDir = path.join(memRoot, key.replace(/[:]/g, '_'));
        const selfScope = key.startsWith('private:') ? 'private' : 'group';
        const recallDirs = [{ dir: selfDir, scope: selfScope }];
        try {
          for (const d of fs.readdirSync(memRoot)) {
            if (!/^(?:group|private)_\d+$/.test(d)) continue;
            const full = path.join(memRoot, d);
            if (full === selfDir) continue;
            recallDirs.push({ dir: full, scope: d.startsWith('private_') ? 'private' : 'group' });
          }
        } catch { /* 没有别的会话就算了 */ }
        const rc = recallColdStorage({
          dirs: recallDirs,
          texts: recallTexts,
          viewer: selfScope,
        });
        if (rc.block) {
          parts.push(rc.block);
          parts.push('');
          log(`[recall] ${key} 注入往事 ${rc.hits.length} 条（${rc.block.length} 字）：${rc.hits.map((h) => h.time).join(' / ')}`);
        }
      }
    } catch (error) {
      log('[recall] 检索失败（不影响这轮）: ' + (error?.message ?? error));
    }
    // 主动机会：以前 proactiveCheck 一天都没触发过一次（idle 要 15 分钟 + 概率 0.3 + 各种折扣），
    // 所以她从来不会自己冒一句。现在告诉模型「这是可以主动开口的时机」。
    if (reason === 'proactiveCheck' || reason === 'timeout') {
      parts.push('【现在是你可以自己开口的时候】群里安静了一会儿。想开口就说**你自己的事**（在干嘛、想到什么、看到什么好玩的小事），**别每次都问他在干嘛、在不在、还上不上课** —— 那是最没话找话的一种。还有：你要是刚说过「不吵你」「你先忙」，就真的别开这个口，等他自己回来。没想说的就省略 reply 继续潜水。');
      parts.push('');
    }
    if (research && research.text) {
      parts.push(research.source === 'kb' ? '【本地知识库（之前搜过的结果）】' : '【刚搜到的结果】');
      parts.push(String(research.text).slice(0, 1200));
      parts.push('（按这些内容回答，别念来源、别说"我查了知识库"，像本来就知道一样）');
      parts.push('');
    }
    // 她自己说「这个我不懂/想不起来」→ 翻旧记录翻到了，带着结果重说一次
    if (sweep && sweep.block) {
      parts.push('【你刚才想不起来，翻了一下群里的旧记录，翻到这些】');
      parts.push(String(sweep.block));
      parts.push('（按这些回答。还是没有的话就照实说记不清了，别编）');
      parts.push('');
    }
    // 她主动要求展开的合并转发（2026-10-26）。lite 没有工具循环，
    // 所以是「先只给 id → 她要读才二次调用」，平时一分钱不花。
    if (fwd && fwd.block) {
      parts.push('【你打开了那条合并转发，里面是这些】');
      parts.push(String(fwd.block));
      parts.push('（照着这个回答。要引用里面某人的话就说清是谁说的；里面看不到的东西别编。）');
      parts.push('');
    }
    if (st.attackMode === true) {
      parts.push('【当前是攻击性模式】嘴更冲、怼得更狠、别客气。但依然不许骂脏话。');
    }
    const through = snapshot?.readThroughSeq;
    if (Number.isSafeInteger(through)) parts.push(`\n（本次读到的水位 readThroughSeq = ${through}，收尾时填进 markThrough）`);
    if (!parts.length) parts.push('（群里暂时没消息）');
    return parts.join('\n');
  }

  /** 把模型输出解析成动作。模型偶尔会包代码块或加解释，这里做容错。 */
  function parseLiteActions(text) {
    let s = String(text ?? '').trim();
    if (!s) return {};
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(s.slice(start, end + 1));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch {}
    }
    // 完全不是 JSON：把整段当成一句话说出去，总比静默强。
    // 但必须带上 __degraded 标记 —— 降级轮里模型是自由写作，JSON 字段约束和那些
    // 「别叫主人——」「同一意思说一遍」的规则全都不在场，是各类毛病的高发区，
    // 上层要据此重试一次（2026-10-26）。
    return { reply: [s.slice(0, 300)], __degraded: true };
  }

  // ── 上下文标记泄漏（2026-10-22 主人在群里当场看到两条） ────────────────
  // 她有时候把「【主人】」「昵称(QQ号)：」「你：」这些**上下文的格式**当成发言内容发出去，
  // 群里变成「【主人】原来是10月啊」「【主人】{{OWNER_NAME}}(1234567890)：「这人最精了」」。
  // 那是我们喂给她的排版，不是她该说的话 —— 发出去前统一剥掉。
  function cleanLiteReplyText(text, st) {
    let s = String(text ?? '').trim();
    if (!s) return '';
    const before = s;
    const names = new Set();
    for (const m of (Array.isArray(st?.recentMessages) ? st.recentMessages : [])) {
      const n = String(m?.sender || '').trim();
      if (n && n.length <= 20) names.add(n);
    }
    for (let round = 0; round < 3; round += 1) {
      const prev = s;
      s = s.replace(/^【[^】]{1,24}】\s*/, '');                                 // 【主人】【戳戳旁边打盹的鲸尾】
      s = s.replace(/^[^\s：:（）()「」]{1,20}[（(]\d{5,12}[）)]\s*[：:]\s*/, ''); // 昵称(123456)：
      s = s.replace(/^你\s*[：:]\s*/, '');                                     // 你：
      for (const n of names) {
        if (s.startsWith(n + '：') || s.startsWith(n + ':')) { s = s.slice(n.length + 1).trim(); break; }
      }
      if (s === prev) break;
    }
    s = s.trim();
    // 剥完只剩一句「别人的原话」= 把上下文抄了一遍，不是她自己的话，丢掉。
    if (s !== before) {
      const bare = s.replace(/^[「『“"]+/, '').replace(/[」』”"]+$/, '').trim();
      if (!bare) return '';
      if (bare !== s) {
        const norm = (x) => String(x || '').replace(/[\s「」『』"“”]/g, '');
        const target = norm(bare);
        if (target.length >= 4) {
          for (const m of (Array.isArray(st?.recentMessages) ? st.recentMessages : [])) {
            if (!m || m.isSelf) continue;
            const src = norm(m.text);
            // 两个方向都查：她把「昵称(QQ)：完整一句」抄下来时是 target 包含 src，
            // 把别人的半句加引号复述时是 src 包含 target。
            if (src.length >= 4 && (src === target
                || target.includes(src.slice(0, Math.min(12, src.length)))
                || (target.length >= 4 && src.includes(target)))) return '';
          }
        }
      }
    }
    return s;
  }

  return { liteConfig, buildLiteSystemPrompt, buildLiteUserMessage, parseLiteActions, cleanLiteReplyText };
}
