(() => {
    'use strict';

    /*
      CONFIGURATION
      - The Google Apps Script endpoint is retained from the supplied website.
      - For production, set tmdbProxyUrl to your Cloudflare Worker URL.
      - tmdbApiKey is only for local testing: browser-side keys are public.
    */
    const CONFIG = Object.freeze({
      driveApiUrl: 'https://script.google.com/macros/s/AKfycbx106XOgQ0HGWsYm1dLzjMz7CIzNFMpBxxSy71yGc_LZP2_s2FbmQFSAaYun3jn1Cao/exec',
      tmdbProxyUrl: (window.TMOVIES_CONFIG && window.TMOVIES_CONFIG.tmdbProxyUrl) || '',
      tmdbApiKey: (window.TMOVIES_CONFIG && window.TMOVIES_CONFIG.tmdbApiKey) || '',
      imageBase: 'https://image.tmdb.org/t/p/',
      cacheMinutes: 35
    });

    const KEYS = {
      index:'tm_index', history:'tm_history', favs:'tm_favs', tmdb:'tm_tmdb',
      art:'tm_art2', folders:'tm_fcache', cats:'tm_cats', genres:'tm_genres', epview:'tm_epview'
    };
    const safeJSON = (key, fallback) => { try { const raw = localStorage.getItem(key); return raw == null ? fallback : JSON.parse(raw); } catch { return fallback; } };
    const store = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch (error) { console.warn('Storage unavailable:', error); } };
    let INDEX = safeJSON(KEYS.index, []), HISTORY = safeJSON(KEYS.history, []), FAVS = safeJSON(KEYS.favs, []);
    let tmdbCache = safeJSON(KEYS.tmdb, {}), artCache = safeJSON(KEYS.art, {}), folderCache = safeJSON(KEYS.folders, {});
    let CATS = safeJSON(KEYS.cats, {movies:null,series:null}), genreMap = safeJSON(KEYS.genres, {});
    let currentFolderId = null, currentStack = [], currentFolderInfo = null, currentEps = [], epView = safeJSON(KEYS.epview, 'list');
    const inFlight = new Map();
    const $ = (selector, root=document) => root.querySelector(selector);
    const $$ = (selector, root=document) => [...root.querySelectorAll(selector)];
    const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    const norm = value => String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').replace(/\b(the|a|an)\b/g,' ').replace(/\s+/g,' ').trim();
    const dice = (a,b) => { const A=new Set(norm(a).split(' ').filter(Boolean)), B=new Set(norm(b).split(' ').filter(Boolean)); if(!A.size||!B.size)return 0; let n=0; A.forEach(t=>{if(B.has(t))n++;}); return 2*n/(A.size+B.size); };
    const fmtYear = value => String(value || '').slice(0,4);
    const image = (path, size='w500') => path ? CONFIG.imageBase + size + path : '';
    const mediaTitle = item => item?.title || item?.name || item?.clean || item?.original_title || item?.original_name || 'Untitled';
    const mediaYear = item => fmtYear(item?.release_date || item?.first_air_date || item?.year);
    const mediaType = item => item?.media_type || (item?.first_air_date || item?.name && !item?.title ? 'tv' : 'movie');
    const mediaKey = item => `tmdb:${mediaType(item)}:${item.id}`;
    const dateLabel = date => date ? new Date(date + 'T00:00:00').toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'}) : 'TBA';
    const runtimeLabel = minutes => minutes ? `${Math.floor(minutes/60)}h ${minutes%60}m` : '';

    function saveAll(){
      store(KEYS.index, INDEX); store(KEYS.history, HISTORY); store(KEYS.favs, FAVS);
      store(KEYS.tmdb, tmdbCache); store(KEYS.art, artCache); store(KEYS.folders, folderCache);
      store(KEYS.cats, CATS); store(KEYS.genres, genreMap); store(KEYS.epview, epView);
    }
    window.addEventListener('beforeunload', saveAll);
    function toast(message){ const el=$('#toast'); el.textContent=message; el.classList.add('show'); clearTimeout(toast.timer); toast.timer=setTimeout(()=>el.classList.remove('show'),2100); }
    function showState(title, message, action=''){ return `<div class="state-message"><div class="eyebrow">T MOVIES · THE FILM JOURNAL</div><h2>${esc(title)}</h2><p>${esc(message)}</p>${action}</div>`; }
    function setMain(html){ const main=$('#main'); main.classList.add('leaving'); main.innerHTML=html; requestAnimationFrame(()=>{main.classList.remove('leaving'); observeReveals();}); }

    async function tmdb(path, params={}, ttl=CONFIG.cacheMinutes){
      const query = new URLSearchParams(params); const cleanPath = String(path).replace(/^\/+/, '');
      const cacheKey = `api:v2:${cleanPath}?${query.toString()}`; const cached = tmdbCache[cacheKey];
      if(cached && cached.data && Date.now()-cached.at < ttl*60000) return cached.data;
      if(inFlight.has(cacheKey)) return inFlight.get(cacheKey);
      const task = (async()=>{
        let url;
        if(CONFIG.tmdbProxyUrl){
          url = `${CONFIG.tmdbProxyUrl.replace(/\/$/,'')}/${cleanPath}`;
          if(query.toString()) url += `?${query.toString()}`;
        } else if(CONFIG.tmdbApiKey){
          query.set('api_key', CONFIG.tmdbApiKey);
          url = `https://api.themoviedb.org/3/${cleanPath}?${query.toString()}`;
        } else {
          const error = new Error('TMDB is not configured. Add a secure TMDB proxy URL to window.TMOVIES_CONFIG.');
          error.code = 'TMDB_NOT_CONFIGURED'; throw error;
        }
        const response = await fetch(url, {headers:{accept:'application/json'}});
        if(!response.ok) throw new Error(`TMDB request failed (${response.status})`);
        const data = await response.json();
        tmdbCache[cacheKey] = {at:Date.now(),data};
        return data;
      })();
      inFlight.set(cacheKey, task);
      try { return await task; } finally { inFlight.delete(cacheKey); }
    }

    async function getFolder(id=null, force=false){
      const key='f_'+(id||'root'); const cached=folderCache[key];
      if(!force && cached && cached.data && Date.now()-(cached.t||0)<5*60000) return cached.data;
      const url=id ? `${CONFIG.driveApiUrl}?folderId=${encodeURIComponent(id)}` : CONFIG.driveApiUrl;
      const response=await fetch(url,{cache:'no-store'});
      if(!response.ok) throw new Error(`Drive connection failed (${response.status})`);
      const json=await response.json();
      if(json.status!=='success') throw new Error('Drive endpoint returned an unsuccessful response');
      folderCache[key]={t:Date.now(),data:json}; return json;
    }

    const YEAR_RE=/\b(19\d{2}|20\d{2})\b/;
    const JUNK_RE=/\b(1080p|720p|480p|2160p|4k|uhd|web-?dl|webrip|bluray|brrip|dvdrip|hdtv|hdrip|x264|x265|hevc|aac|dts|ac3|hdr|yify|esubs?|multisub|dual audio|bangla|bengali|hindi|tamil|telugu|malayalam|kannada|marathi|urdu|download|watch|online|free|full movie|full|hd|sd|hq|movie|film|series|show|complete|uncut|unrated|extended|remastered|collection)\b/gi;
    const SE_RES=[/\b[Ss](\d{1,2})\s*[.\-_ ]?\s*[Ee](?:[Pp])?\s*(\d{1,3})\b/,/\b(\d{1,2})x(\d{2,3})\b/,/\bEpisode\s*(\d{1,3})\b/i,/\b[Ee][Pp]\s*(\d{1,3})\b/,/(?<![A-Za-z0-9])[Ee](\d{1,3})\b/,/\b(?:Season|[Ss])\s*(\d{1,2})\b/,/\b(\d{1,2})(?:st|nd|rd|th)\s*Season\b/i];
    const SE_TOK=[/\b[Ss]\d{1,2}\s*[.\-_ ]?\s*[Ee][Pp]?\s*\d{1,3}\b/g,/\b\d{1,2}x\d{2,3}\b/g,/\bEpisode\s*\d{1,3}\b/gi,/\b[Ee][Pp]\s*\d{1,3}\b/g,/\bSeason\s*\d{1,2}\b/gi,/\b[Ss]\d{1,2}\b/g,/\b\d{1,2}(?:st|nd|rd|th)\s*Season\b/gi];
    function detectSE(text){ let m=text.match(SE_RES[0]); if(m)return{season:+m[1],episode:+m[2]}; m=text.match(SE_RES[1]); if(m&&+m[1]<=30)return{season:+m[1],episode:+m[2]}; m=text.match(SE_RES[2]);if(m)return{season:null,episode:+m[1]};m=text.match(SE_RES[3]);if(m)return{season:null,episode:+m[1]};m=text.match(SE_RES[4]);if(m)return{season:null,episode:+m[1]};m=text.match(SE_RES[5]);if(m)return{season:+m[1],episode:null};m=text.match(SE_RES[6]);if(m)return{season:+m[1],episode:null};return{season:null,episode:null}; }
    function analyzeName(name,isFolder=false){
      let s=String(name||'').replace(/\.[a-z0-9]{2,4}$/i,'').replace(/[._]+/g,' '); s=s.replace(/^(\d{1,3})\s*[-.:]\s*/,'').replace(/^\d{1,3}\s+/,'');
      const yearMatch=s.match(YEAR_RE), year=yearMatch?+yearMatch[1]:null, se=detectSE(s); let display=s;
      SE_TOK.forEach(regex=>display=display.replace(regex,' ')); display=display.replace(JUNK_RE,' '); if(year)display=display.replace(String(year),' ');
      display=display.replace(/\s+/g,' ').replace(/^[- ]+|[- ]+$/g,'').trim();
      const kind=se.episode!==null?'episode':se.season!==null?(isFolder?'season':'episode'):(isFolder?'series':'movie');
      return{original:name,display,year,season:se.season,episode:se.episode,seasonLabel:se.season!==null?`Season ${se.season}`:null,kind,isFolder};
    }
    function indexAdd(list,parent=null){ const map=new Map(INDEX.map(item=>[item.id,item])); list.forEach(item=>map.set(item.id,{...(map.get(item.id)||{}),...item,parent})); INDEX=[...map.values()].slice(-1200); }
    function stackFor(id){const stack=[];let parent=INDEX.find(item=>item.id===id)?.parent;let guard=0;while(parent&&guard++<24){const item=INDEX.find(x=>x.id===parent);if(!item)break;stack.unshift({id:parent,clean:item.clean});parent=item.parent;}return stack;}
    function contextTitle(){for(let i=currentStack.length-1;i>=0;i--)if(currentStack[i].clean)return currentStack[i].clean;return currentFolderInfo?.display||'';}
    function detectCategories(folders){folders.forEach(folder=>{const n=folder.name.toLowerCase();if(!CATS.movies&&/movie|film/.test(n))CATS.movies=folder.id;if(!CATS.series&&/series|\btv\b|anime|show/.test(n))CATS.series=folder.id;});}

    async function searchPool(query,type,year){
      const key=`pool2:${type}:${norm(query)}:${year||''}`; if(key in tmdbCache)return tmdbCache[key]; const pool=[];
      const grab=async(t,y)=>{try{const params={query};if(y)params[t==='tv'?'first_air_date_year':'year']=y;const data=await tmdb(`search/${t}`,params,240);pool.push(...(data.results||[]));}catch(error){console.warn(error);}};
      if(type==='tv'){if(year)await grab('tv',year);await grab('tv');await grab('movie');}else{if(year)await grab('movie',year);await grab('movie');await grab('tv');}
      const seen=new Set();const list=pool.filter(item=>{const k=`${item.media_type||type}:${item.id}`;if(seen.has(k))return false;seen.add(k);return true;}).sort((a,b)=>(b.popularity||0)-(a.popularity||0));
      tmdbCache[key]=list.slice(0,8);return tmdbCache[key];
    }
    async function verify(query,type,year){
      const key=`ver2:${type}:${norm(query)}:${year||''}`;if(key in tmdbCache)return tmdbCache[key];const pool=await searchPool(query,type,year);let best=null;
      for(const result of pool){const resultYear=+(fmtYear(result.release_date||result.first_air_date)||0);const similarity=dice(norm(query),norm(result.title||result.name));const yearOk=!year||!resultYear||resultYear===year||Math.abs(resultYear-year)===1;if((similarity>=.6&&yearOk)||similarity>=.92){best=result;break;}}
      if(best)tmdbCache[`obj2:${best.id}`]=best;tmdbCache[key]=best;return best;
    }
    async function seasonPoster(id,number){const key=`sp2:${id}:${number}`;if(key in artCache)return artCache[key];try{const data=await tmdb(`tv/${id}/season/${number}`,{},240);artCache[key]=data.poster_path?image(data.poster_path):null;return artCache[key];}catch{return null;}}
    async function episodeStill(id,season,episode){const key=`es2:${id}:${season}:${episode}`;if(key in artCache)return artCache[key];try{const data=await tmdb(`tv/${id}/season/${season}/episode/${episode}`,{},240);artCache[key]=data.still_path?image(data.still_path):null;return artCache[key];}catch{return null;}}
    async function resolveArt(item){
      const key=`art2:${item.kind}|${norm(item.clean||item.sq||item.name)}|${item.season??''}|${item.episode??''}`;if(key in artCache)return artCache[key];
      const art={p:null,b:null,bo:null,id:null,title:null};const query=item.clean||item.sq||contextTitle();
      if(query){try{const tvLike=['episode','season','series'].includes(item.kind);const result=await verify(query,tvLike?'tv':'movie',item.kind==='series'?item.year:item.year);
        if(result){art.id=result.id;art.title=result.title||result.name;art.p=image(result.poster_path);art.b=image(result.backdrop_path,'w1280');art.bo=image(result.backdrop_path,'original');
          if(tvLike&&item.season!=null){const sp=await seasonPoster(result.id,item.season);if(sp)art.p=sp;if(item.kind==='episode'&&item.episode!=null){const still=await episodeStill(result.id,item.season,item.episode);if(still)art.b=still;}}
        }}catch(error){console.warn('Artwork lookup failed:',error);}}
      artCache[key]=art;return art;
    }
    function placeholder(title='T MOVIES',ratio='2/3'){
      const [w,h]=ratio==='16/9'?[640,360]:[400,600];const letter=esc(String(title).trim().charAt(0).toUpperCase()||'T');
      const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#e9dfd3"/><stop offset="1" stop-color="#f6f0e7"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="${w*.5}" cy="${h*.42}" r="${Math.min(w,h)*.24}" fill="none" stroke="#792d42" stroke-opacity=".25"/><text x="50%" y="52%" text-anchor="middle" fill="#792d42" font-size="${Math.min(w,h)*.25}" font-family="Georgia">${letter}</text><text x="50%" y="88%" text-anchor="middle" fill="#82766d" font-size="${Math.min(w,h)*.035}" letter-spacing="5" font-family="Arial">T MOVIES</text></svg>`;
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    }

    async function bestDriveMatch(media){
      const title=norm(mediaTitle(media)), year=+(mediaYear(media)||0); if(!title)return null;
      if(mediaType(media)==='tv'){
        const folders=INDEX.filter(item=>item.type==='folder'&&item.kind==='series');
        const ranked=folders.map(item=>{const candidate=norm(item.clean||analyzeName(item.name,true).display);const similarity=dice(title,candidate);return{item,similarity};}).sort((a,b)=>b.similarity-a.similarity);
        return ranked[0]?.similarity>=.88?ranked[0].item:null;
      }
      const candidates=INDEX.filter(item=>item.type==='video'&&item.kind!=='episode'&&item.kind!=='season');
      // First honour an existing, verified artwork-to-TMDB association from the original matching system.
      for(const item of candidates){const cacheKey=`art2:${item.kind}|${norm(item.clean||item.sq||item.name)}|${item.season??''}|${item.episode??''}`;if(artCache[cacheKey]?.id===media.id)return item;}
      const ranked=candidates.map(item=>{const itemTitle=norm(item.clean||analyzeName(item.name,false).display);const itemYear=+(item.year||0);const similarity=dice(title,itemTitle);const yearOk=!year||!itemYear||year===itemYear||Math.abs(year-itemYear)===1;return{item,similarity,yearOk,score:similarity+(year&&itemYear&&year===itemYear?.08:0)};}).filter(row=>row.yearOk&&row.similarity>=.48).sort((a,b)=>b.score-a.score).slice(0,4);
      // Reuse the same TMDB filename verification logic used for posters before exposing a watch link.
      for(const row of ranked){try{const art=await resolveArt(row.item);if(art.id===media.id)return row.item;}catch(error){console.warn('Drive association check failed:',error);}}
      const strong=ranked.filter(row=>row.similarity>=.9);if(strong.length===1)return strong[0].item;if(year){const exactYear=strong.find(row=>Number(row.item.year)===year);if(exactYear)return exactYear.item;}return null;
    }
    function isFav(id){return FAVS.some(item=>item.id===id);}
    function toggleFav(item){
      const id=item.id;const index=FAVS.findIndex(f=>f.id===id);
      if(index>=0){FAVS.splice(index,1);toast('Removed from My List');}
      else{FAVS.push({id,clean:item.clean||mediaTitle(item),kind:item.kind||mediaType(item),tmdbId:item.tmdbId||((String(id).startsWith('tmdb:'))?Number(String(id).split(':').pop()):null),mediaType:item.mediaType||mediaType(item)});toast('Added to My List');}
      $('#fav-count').textContent=FAVS.length;saveAll();$$(`[data-fav="${CSS.escape(id)}"]`).forEach(button=>{button.classList.toggle('saved',isFav(id));button.setAttribute('aria-label',isFav(id)?'Remove from My List':'Add to My List');});
    }
    function mediaObject(item){return{...item,media_type:mediaType(item)};}
    function posterCard(item){
      const type=mediaType(item), title=mediaTitle(item), key=mediaKey({...item,media_type:type});
      const poster=image(item.poster_path);const src=poster||placeholder(title);const rating=item.vote_average?Number(item.vote_average).toFixed(1):'';
      return `<article class="poster-card reveal" data-open-media="${esc(type)}:${esc(item.id)}" tabindex="0" role="button" aria-label="View ${esc(title)}">
        <div class="poster-frame"><img src="${esc(src)}" alt="${esc(title)} poster" loading="lazy" onerror="this.src='${placeholder(title)}';this.onerror=null">
          ${item.badge?`<span class="poster-badge">${esc(item.badge)}</span>`:''}${rating?`<span class="poster-rating">★ ${rating}</span>`:''}
          <div class="poster-hover"><button class="quick-btn" data-card-info="${esc(type)}:${esc(item.id)}" aria-label="More information"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button><button class="quick-btn" data-fav="${esc(key)}" data-fav-title="${esc(title)}" aria-label="${isFav(key)?'Remove from My List':'Add to My List'}"><svg viewBox="0 0 24 24"><path d="M20.8 8.8c0 5.2-8.8 11-8.8 11s-8.8-5.8-8.8-11a4.6 4.6 0 0 1 8.8-1.8 4.6 4.6 0 0 1 8.8 1.8Z"/></svg></button></div>
        </div><div class="poster-info"><div class="poster-title">${esc(title)}</div><div class="poster-year">${esc(mediaYear(item)|| (type==='tv'?'SERIES':'FEATURE FILM'))}</div></div>
      </article>`;
    }
    function driveCard(item, poster=false){
      const title=item.clean||item.name||'Untitled';const art=artCache[`art2:${item.kind}|${norm(item.clean||item.sq||item.name)}|${item.season??''}|${item.episode??''}`]||{};
      const src=(poster?art.p:(art.b||art.p))||placeholder(title,poster?'2/3':'16/9');
      const folder=item.type==='folder'||item.kind==='series'||item.kind==='season';
      return `<article class="poster-card reveal" data-drive-item="${esc(item.id)}" tabindex="0" role="button" aria-label="${folder?'Open':'View'} ${esc(title)}"><div class="poster-frame"><img src="${esc(src)}" alt="${esc(title)}" loading="lazy" onerror="this.src='${placeholder(title,poster?'2/3':'16/9')}';this.onerror=null">${item.year?`<span class="poster-badge">${item.year}</span>`:''}<div class="poster-hover"><button class="quick-btn" ${folder?`data-browse="${esc(item.id)}" aria-label="Open ${esc(title)} folder"`:`data-drive-play="${esc(item.id)}" aria-label="Watch ${esc(title)}"`}><svg viewBox="0 0 24 24">${folder?'<path d="M4 12h15M13 5l7 7-7 7"/>':'<path d="m8 5 11 7-11 7z"/>'}</svg></button><button class="quick-btn" data-fav="${esc(item.id)}" aria-label="Add to My List"><svg viewBox="0 0 24 24"><path d="M20.8 8.8c0 5.2-8.8 11-8.8 11s-8.8-5.8-8.8-11a4.6 4.6 0 0 1 8.8-1.8 4.6 4.6 0 0 1 8.8 1.8Z"/></svg></button></div></div><div class="poster-info"><div class="poster-title">${esc(title)}</div><div class="poster-year">${esc(item.year||item.seasonLabel||(folder?'OPEN FOLDER':'IN YOUR ARCHIVE'))}</div></div></article>`;
    }
    function section(title, subtitle, items, options={}){
      if(!items?.length)return '';
      const cards=items.map(item=>options.drive?driveCard(item,options.poster!==false):posterCard(item)).join('');
      return `<section class="section reveal"><div class="section-head"><div><h2 class="section-title">${esc(title)}</h2>${subtitle?`<p class="section-sub">${esc(subtitle)}</p>`:''}</div>${options.more?`<a class="text-link" href="${options.more}">Explore all ↗</a>`:''}</div><div class="rail-wrap"><div class="rail">${cards}</div></div></section>`;
    }
    function pageHead(title, description, tools=''){return `<div class="page-head"><div class="page-head-inner"><div><div class="eyebrow">T MOVIES · THE CINEMA COLLECTION</div><h1 class="page-title">${esc(title)}</h1><p class="page-description">${esc(description)}</p></div><div class="page-tools">${tools}</div></div></div>`;}

    function setActiveNav(page){
      const active=({ 'movie':'movies','series-details':'series','genre':'discover','archive':'archive','watch':'movies','search':'discover' })[page]||page;
      $$('.nav-links a').forEach(a=>a.classList.toggle('active',a.dataset.route===active));
    }
    let routeToken=0;
    async function route(){
      const token=++routeToken;clearInterval(heroTimer);heroTimer=null;
      const page=document.body.dataset.page||'home';const params=new URLSearchParams(location.search);
      closeSearch();closeMobileMenu();closeModal();setActiveNav(page);
      window.scrollTo({top:0,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
      if(page==='archive'){currentFolderId=params.get('folder')||null;if(currentFolderId&&!INDEX.length)await loadDriveRoot();currentStack=currentFolderId?stackFor(currentFolderId):[];return renderBrowse(false,token);}
      if(page==='movies')return renderMovies(token);
      if(page==='series')return renderSeries(token);
      if(page==='discover')return renderDiscover(token);
      if(page==='my-list')return renderWishlist(token);
      if(page==='movie')return renderDetails(Number(params.get('id')), 'movie', token);
      if(page==='series-details')return renderDetails(Number(params.get('id')), 'tv', token);
      if(page==='genre'){const id=params.get('id')||'';if(params.get('name'))genreMap[id]=params.get('name');return renderGenre(id,token);}
      if(page==='search')return renderSearchPage(params.get('q')||'',token);
      if(page==='watch')return renderWatchPage(params.get('id')||'',params.get('title')||'',token);
      return renderHome(token);
    }

    function renderCinematicWall(items){
      const wall=$('#cinema-wall');if(!wall)return;
      const seen=new Set();
      const picks=(items||[]).filter(item=>{
        if(!item?.poster_path||!item?.id)return false;
        const key=`${mediaType(item)}:${item.id}`;if(seen.has(key))return false;seen.add(key);return true;
      }).slice(0,12);
      wall.innerHTML=picks.map((item,index)=>`<figure class="cinema-wall-tile cinema-wall-tile--${index+1}" style="--wall-rotate:${[-7,5,-3,8,-5,4,6,-8,3,-4,7,-2][index]}deg">
        <img src="${esc(image(item.poster_path,'w500'))}" alt="" loading="lazy" decoding="async">
        <figcaption>${esc(mediaTitle(item))}</figcaption>
      </figure>`).join('');
      wall.classList.toggle('ready',picks.length>0);
    }
    async function loadCinematicWall(){
      const wall=$('#cinema-wall');if(!wall||wall.dataset.loaded==='true')return;
      wall.dataset.loaded='true';
      const results=await Promise.allSettled([tmdb('trending/all/week'),tmdb('tv/popular'),tmdb('movie/popular')]);
      const items=results.flatMap(result=>result.status==='fulfilled'?(result.value.results||[]):[]);
      renderCinematicWall(items);
    }

    async function loadHomeData(){
      const tasks=[tmdb('trending/movie/week'),tmdb('movie/popular'),tmdb('movie/top_rated'),tmdb('movie/upcoming'),tmdb('tv/popular'),tmdb('genre/movie/list'),tmdb('genre/tv/list'),tmdb('trending/tv/week'),tmdb('trending/all/week')];
      const results=await Promise.allSettled(tasks);const value=i=>results[i].status==='fulfilled'?results[i].value:null;
      const genres=[...(value(5)?.genres||[]),...(value(6)?.genres||[])];genres.forEach(g=>genreMap[g.id]=g.name);genreMap._ok=true;store(KEYS.genres,genreMap);
      return{trending:value(0)?.results||[],popular:value(1)?.results||[],top:value(2)?.results||[],upcoming:value(3)?.results||[],tv:value(4)?.results||[],trendingTV:value(7)?.results||[],trendingAll:value(8)?.results||[],tmdbReady:results.some(r=>r.status==='fulfilled')};
    }
    async function loadDriveRoot(){try{const root=await getFolder(null);detectCategories(root.folders||[]);indexAdd((root.folders||[]).map(folder=>{const a=analyzeName(folder.name,true);return{id:folder.id,name:folder.name,clean:a.display,type:'folder',kind:a.kind,season:a.season,dateAdded:folder.dateAdded};}),null);indexAdd((root.videos||[]).map(video=>{const a=analyzeName(video.name,false);return{id:video.id,name:video.name,clean:a.display,type:'video',kind:a.kind,season:a.season,episode:a.episode,year:a.year,sizeMB:video.sizeMB,dateAdded:video.dateAdded};}),null);saveAll();return root;}catch(error){console.warn('Drive archive unavailable:',error);return null;}}

    async function renderHome(token=routeToken){
      setMain(`<section class="hero"><div class="hero-media" id="hero-media"></div><div class="hero-character-wall" id="hero-character-wall" aria-hidden="true"></div><div class="hero-orbit" aria-hidden="true"></div><div class="hero-content"><div class="hero-copy" id="hero-copy"><div class="hero-kicker eyebrow">A NEW WAY TO SEE CINEMA</div><h1 class="hero-title" id="hero-title">Find the film<br>that stays with you.</h1><div class="hero-meta" id="hero-meta"><span>CURATED DISCOVERY</span><i class="meta-dot"></i><span>T MOVIES</span></div><p class="hero-desc" id="hero-desc">A living collection of stories, worlds and unforgettable performances. Discover something worth your time.</p><div class="hero-actions"><a class="btn btn-primary" id="hero-view" href="./discover.html"><svg viewBox="0 0 24 24"><path d="M8 5h8M8 12h8M8 19h8"/></svg> View film</a><a class="btn btn-ghost" href="./discover.html">Discover more</a></div></div></div><div class="hero-bottom"><div class="hero-index"><b id="hero-number">01</b><span id="hero-count">FEATURED SELECTION</span></div><div class="hero-controls"><button id="hero-prev" aria-label="Previous featured film">‹</button><button id="hero-next" aria-label="Next featured film">›</button></div></div><div class="hero-progress" id="hero-progress"></div></section><div class="home-stack" id="home-sections"><div class="section"><div class="skeleton skeleton-poster" style="width:100%;max-width:190px"></div></div></div>`);
      const [home,root]=await Promise.all([loadHomeData().catch(error=>{console.warn(error);return null;}),loadDriveRoot()]);
      if(token!==routeToken)return;
      const movies=home?.trending?.length?home.trending:home?.popular||[];const heroItems=movies.slice(0,5);
      if(heroItems.length){
        const collageItems=[...(home?.trendingAll||[]),...(home?.trendingTV||[]),...(home?.tv||[]),...(home?.popular||[]),...movies];
        setupHero(heroItems,collageItems);
      }
      const newest=INDEX.filter(item=>item.type==='video').sort((a,b)=>(b.dateAdded||0)-(a.dateAdded||0)).slice(0,14);
      const folders=(root?.folders||[]).slice(0,12);
      for(const item of newest.slice(0,8)){await resolveArt(item);if(token!==routeToken)return;}
      const sections=[];
      const continueItems=HISTORY.slice(0,10).map(history=>INDEX.find(item=>item.id===history.id)||Object.assign({id:history.id,name:history.name,clean:analyzeName(history.name||'',false).display,type:'video',sizeMB:history.sizeMB},analyzeName(history.name||'',false)));
      if(continueItems.length)sections.push(section('Continue watching','Pick up where you left off',continueItems,{drive:true}));
      if(home){sections.push(section('Trending now','Stories everyone is talking about',home.trending));sections.push(section('Popular films','The most watched across the collection',home.popular,{more:'./movies.html'}));sections.push(section('The highest rated','A few films worth making time for',home.top));sections.push(section('Coming soon','Keep an eye on what is next',home.upcoming));sections.push(section('On the small screen','Series to settle into',home.tv,{more:'./series.html'}));}
      if(newest.length)sections.push(section('Recently added to your archive','Your personal collection, newly indexed',newest,{drive:true}));
      if(folders.length)sections.push(`<section class="section reveal"><div class="section-head"><div><h2 class="section-title">Explore your folders</h2><p class="section-sub">Your existing Google Drive collection</p></div></div><div class="genre-grid" style="width:100%;margin:0">${folders.map(folder=>`<div class="genre-tile" data-browse="${esc(folder.id)}"><small>ARCHIVE</small><span>${esc(analyzeName(folder.name,true).display||folder.name)}</span></div>`).join('')}</div></section>`);
      if(!home?.tmdbReady)sections.unshift(`<div class="library-note"><b>TMDB connection not configured.</b> Your Google Drive archive remains available. Add a secure TMDB proxy to enable live discovery, search and movie details.</div>`);
      if(!root)sections.unshift(`<div class="library-note"><b>Drive archive unavailable.</b> Check that the existing Apps Script deployment is public and responding.</div>`);
      if(!sections.join(''))sections.push(showState('Your cinema is ready','Connect TMDB for discovery and check your Google Drive endpoint to populate your archive.'));
      $('#home-sections').innerHTML=sections.join('');observeReveals();
    }
    let heroTimer=null,heroIndex=0,heroItems=[];
    function setupHero(items,collageItems=items){heroItems=items;heroIndex=0;renderHeroCharacterWall(collageItems);showHero();$('#hero-prev').onclick=()=>{heroIndex=(heroIndex-1+heroItems.length)%heroItems.length;showHero();};$('#hero-next').onclick=()=>{heroIndex=(heroIndex+1)%heroItems.length;showHero();};clearInterval(heroTimer);if(heroItems.length>1)heroTimer=setInterval(()=>{heroIndex=(heroIndex+1)%heroItems.length;showHero();},8500);}
    function renderHeroCharacterWall(items){
      const wall=$('#hero-character-wall');if(!wall)return;
      const seen=new Set();
      const picks=(items||[]).filter(item=>{
        if(!item?.poster_path||!item?.id)return false;
        const key=`${mediaType(item)}:${item.id}`;if(seen.has(key))return false;seen.add(key);return true;
      }).slice(0,8);
      wall.innerHTML=picks.map((item,index)=>`<figure class="hero-character-card hero-character-card--${index+1}" data-depth="${index+1}" data-media="${mediaType(item)}">
        <img src="${esc(image(item.poster_path,'w500'))}" alt="" loading="lazy" decoding="async">
        <figcaption><span>${mediaType(item)==='tv'?'SERIES':'FILM'}</span> · ${esc(mediaTitle(item))}</figcaption>
      </figure>`).join('');
    }
    function showHero(){const item=heroItems[heroIndex];if(!item)return;const backdrop=image(item.backdrop_path,'original')||image(item.poster_path,'w1280');const bg=$('#hero-media');bg.classList.remove('loaded');bg.style.opacity='0';bg.style.backgroundImage=`url("${backdrop}")`;requestAnimationFrame(()=>{bg.classList.add('loaded');bg.style.opacity='1';});$('#hero-title').textContent=mediaTitle(item);$('#hero-desc').textContent=item.overview||'A story waiting to be discovered.';$('#hero-meta').innerHTML=`<span class="rating">★ ${item.vote_average?Number(item.vote_average).toFixed(1):'—'}</span><i class="meta-dot"></i><span>${esc(mediaYear(item)||'COMING SOON')}</span><i class="meta-dot"></i><span>${mediaType(item)==='tv'?'SERIES':'FEATURE FILM'}</span>`;$('#hero-number').textContent=String(heroIndex+1).padStart(2,'0');$('#hero-count').textContent=`0${heroItems.length} FEATURED`;$('#hero-progress').style.width=`${((heroIndex+1)/heroItems.length)*100}%`;$('#hero-view').href=`./${mediaType(item)==='tv'?'series-details':'movie'}.html?id=${encodeURIComponent(item.id)}`;}

    async function renderMovies(token=routeToken){
      setMain(pageHead('The film collection','A carefully gathered selection of cinema, from the latest releases to all-time favourites.',`<select class="filter-select" id="movie-sort" aria-label="Sort movies"><option value="popularity">Most popular</option><option value="rating">Highest rated</option><option value="release">Newest first</option></select>`)+`<div class="content-grid" id="movie-grid"><div class="loader"></div></div>`);
      if(!INDEX.length||!CATS.movies)await loadDriveRoot();if(token!==routeToken)return;
      try{const data=await tmdb('movie/popular');if(token!==routeToken)return;const list=data.results||[];renderMediaGrid('#movie-grid',list);$('#movie-sort').onchange=async e=>{const mode=e.target.value;const path=mode==='rating'?'movie/top_rated':mode==='release'?'movie/now_playing':'movie/popular';try{const d=await tmdb(path);renderMediaGrid('#movie-grid',d.results||[]);}catch(error){toast(error.message);}};}catch(error){if(token!==routeToken)return;$('#movie-grid').innerHTML=showState(error.code==='TMDB_NOT_CONFIGURED'?'Connect TMDB to discover films':'Could not load movies',error.message||'Please try again in a moment.');}
      if(token!==routeToken)return;
      if(CATS.movies){try{const archive=await getFolder(CATS.movies);if(token!==routeToken)return;indexAdd((archive.videos||[]).map(video=>{const a=analyzeName(video.name,false);return{id:video.id,name:video.name,clean:a.display,type:'video',kind:a.kind==='episode'?'movie':a.kind,season:a.season,episode:a.episode,year:a.year,sizeMB:video.sizeMB,dateAdded:video.dateAdded};}),CATS.movies);const local=INDEX.filter(item=>item.type==='video'&&item.kind==='movie'&&item.parent===CATS.movies);if(local.length){$('#movie-grid').insertAdjacentHTML('afterend',section('Your movie archive','Existing Google Drive titles',local,{drive:true}));for(const item of local.slice(0,12)){await resolveArt(item);if(token!==routeToken)return;}const archiveSection=$$('#main .section').at(-1);if(archiveSection){archiveSection.outerHTML=section('Your movie archive','Existing Google Drive titles',local,{drive:true});}}}catch(error){console.warn('Could not load movie archive:',error);}}
    }
    async function renderSeries(token=routeToken){
      setMain(pageHead('Stories in seasons','Explore series, seasons and episodes from the wider world of television.')+`<div class="section" style="margin-top:30px"><div class="section-head"><div><h2 class="section-title">Popular series</h2><p class="section-sub">Discover something to follow</p></div></div><div class="content-grid" style="width:100%;margin:0" id="series-grid"><div class="loader"></div></div></div><div id="drive-series"></div>`);
      if(!INDEX.length||!CATS.series)await loadDriveRoot();if(token!==routeToken)return;
      try{const data=await tmdb('tv/popular');if(token!==routeToken)return;renderMediaGrid('#series-grid',data.results||[]);}catch(error){if(token===routeToken)$('#series-grid').innerHTML=showState('Series discovery unavailable',error.message);}
      if(token!==routeToken)return;
      if(CATS.series){try{const data=await getFolder(CATS.series);if(token!==routeToken)return;indexAdd((data.folders||[]).map(folder=>{const a=analyzeName(folder.name,true);return{id:folder.id,name:folder.name,clean:a.display,type:'folder',kind:a.kind,season:a.season};}),CATS.series);const series=INDEX.filter(item=>item.type==='folder'&&item.kind==='series');if(series.length)$('#drive-series').innerHTML=section('Your series archive','Existing folders and season structure',series,{drive:true});}catch(error){console.warn(error);}}
    }
    async function renderDiscover(token=routeToken){
      setMain(pageHead('Discover','Follow a genre, revisit a favourite mood, or let the next story find you.')+`<div class="section" style="margin-top:32px"><div class="section-head"><div><h2 class="section-title">Browse by mood</h2><p class="section-sub">Choose a world to step into</p></div></div><div class="genre-grid" id="genre-grid"><div class="loader"></div></div></div><div class="section" id="discover-trending"></div>`);
      try{const [movieGenres,tvGenres,trending]=await Promise.all([tmdb('genre/movie/list'),tmdb('genre/tv/list'),tmdb('trending/movie/week')]);if(token!==routeToken)return;const genres=[...(movieGenres.genres||[]),...(tvGenres.genres||[])];const seen=new Set();const unique=genres.filter(g=>{if(seen.has(g.id))return false;seen.add(g.id);genreMap[g.id]=g.name;return true;});store(KEYS.genres,genreMap);$('#genre-grid').innerHTML=unique.map((g,i)=>`<div class="genre-tile" data-genre="${g.id}"><small>${String(i+1).padStart(2,'0')}</small><span>${esc(g.name)}</span></div>`).join('');$('#discover-trending').innerHTML=section('A little inspiration','Popular films this week',trending.results||[]);}catch(error){if(token===routeToken)$('#genre-grid').innerHTML=showState('Genres unavailable',error.message);}
    }
    async function renderGenre(id,token=routeToken){
      const name=genreMap[id]||'Selected genre';setMain(pageHead(name,`A collection of films in ${name.toLowerCase()}.`)+`<div class="content-grid" id="genre-results"><div class="loader"></div></div>`);
      try{const data=await tmdb('discover/movie',{with_genres:id,sort_by:'popularity.desc'});if(token!==routeToken)return;renderMediaGrid('#genre-results',data.results||[]);}catch(error){if(token===routeToken)$('#genre-results').innerHTML=showState('Could not load this collection',error.message);}
    }
    function renderMediaGrid(selector,items){const grid=$(selector);if(!grid)return;grid.innerHTML=items.length?items.map(posterCard).join(''):showState('Nothing here yet','Try another collection or check back later.');observeReveals();}

    async function renderBrowse(force=false,token=routeToken){
      setMain(`<div class="breadcrumb" id="crumb"><a href="./index.html">HOME</a></div>${pageHead('Your archive','Browse your existing Google Drive folders and movie links.')}<div id="browse-content"><div class="loader"></div></div>`);
      let data;try{data=await getFolder(currentFolderId,force);if(token!==routeToken)return;}catch(error){if(token===routeToken)$('#browse-content').innerHTML=showState('Archive unavailable','Could not load this Google Drive folder. Check the Apps Script deployment and access permissions.');return;}
      currentFolderInfo=analyzeName(data.currentFolder?.name||'Your archive',true);
      indexAdd((data.folders||[]).map(folder=>{const a=analyzeName(folder.name,true);return{id:folder.id,name:folder.name,clean:a.display,type:'folder',kind:a.kind,season:a.season,dateAdded:folder.dateAdded};}),currentFolderId);
      indexAdd((data.videos||[]).map(video=>{const a=analyzeName(video.name,false);return{id:video.id,name:video.name,clean:a.display,type:'video',kind:a.kind,season:a.season,episode:a.episode,year:a.year,sizeMB:video.sizeMB,dateAdded:video.dateAdded};}),currentFolderId);
      const crumbs=[`<a href="./index.html">HOME</a>`,...currentStack.map(item=>`<span> / </span><a href="./archive.html?folder=${encodeURIComponent(item.id)}">${esc(item.clean||'Folder')}</a>`),`<span> / </span>${esc(currentFolderInfo.display||data.currentFolder?.name||'Archive')}`];$('#crumb').innerHTML=crumbs.join('');
      const folders=[...(data.folders||[])].sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}));const videos=[...(data.videos||[])].sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true})).map(video=>Object.assign({id:video.id,name:video.name,sizeMB:video.sizeMB,dateAdded:video.dateAdded,sq:null},analyzeName(video.name,false)));
      const inSeason=currentFolderInfo.kind==='season';videos.forEach(video=>{if(inSeason&&video.kind==='movie')video.kind='episode';video.sq=video.display||contextTitle();});currentEps=videos.filter(video=>video.kind!=='movie');const movies=videos.filter(video=>video.kind==='movie');
      for(const item of [...folders.slice(0,8).map(folder=>Object.assign({id:folder.id,name:folder.name,type:'folder',sq:analyzeName(folder.name,true).display||contextTitle()},analyzeName(folder.name,true))),...videos.slice(0,12)]){await resolveArt(item);if(token!==routeToken)return;}
      let html=`<div class="library-note"><b>${(data.folders||[]).length} folders · ${(data.videos||[]).length} files</b><span>Existing Google Drive associations are preserved.</span><button class="text-link" id="browse-refresh" style="margin-left:auto">REFRESH ↻</button></div>`;
      if(folders.length)html+=`<section class="section"><div class="section-head"><h2 class="section-title">Folders & seasons</h2></div><div class="content-grid" style="width:100%;margin:0">${folders.map(folder=>{const a=analyzeName(folder.name,true);const item=Object.assign({id:folder.id,name:folder.name,type:'folder',sq:a.display||contextTitle()},a);const art=artCache[`art2:${item.kind}|${norm(item.clean||item.sq||item.name)}|${item.season??''}|${item.episode??''}`]||{};return`<article class="poster-card" data-browse="${esc(folder.id)}"><div class="poster-frame"><img src="${esc(art.p||art.b||placeholder(a.display||folder.name))}" alt="${esc(a.display||folder.name)}" loading="lazy"><span class="poster-badge">FOLDER</span></div><div class="poster-info"><div class="poster-title">${esc(a.display||folder.name)}</div><div class="poster-year">OPEN ARCHIVE ↗</div></div></article>`;}).join('')}</div></section>`;
      if(movies.length)html+=section('Movies in this folder','Play files from your connected archive',movies,{drive:true});
      if(currentEps.length)html+=`<section class="section"><div class="section-head"><div><h2 class="section-title">Episodes</h2><p class="section-sub">${currentEps.length} episodes in this folder</p></div><div class="page-tools"><button class="filter-select" data-ep-view="list">List</button><button class="filter-select" data-ep-view="grid">Grid</button></div></div><div id="episode-area"></div></section>`;
      if(!folders.length&&!movies.length&&!currentEps.length)html+=showState('This folder is empty','There are no folders or video files available here yet.');
      $('#browse-content').innerHTML=html;$('#browse-refresh').onclick=()=>renderBrowse(true);renderEpisodes();observeReveals();
    }
    async function renderEpisodes(){const area=$('#episode-area');if(!area||!currentEps.length)return;if(epView==='grid'){area.innerHTML=`<div class="content-grid" style="width:100%;margin:0">${currentEps.map(item=>driveCard(item)).join('')}</div>`;return;}area.innerHTML=`<div style="border-top:1px solid var(--line)">${currentEps.map((item,i)=>`<div data-drive-play="${esc(item.id)}" style="display:flex;align-items:center;gap:15px;padding:13px 5px;border-bottom:1px solid var(--line);cursor:pointer"><span style="font:14px var(--mono);color:var(--muted);width:25px">${String(item.episode??i+1).padStart(2,'0')}</span><img src="${placeholder(item.clean||item.name,'16/9')}" style="width:105px;aspect-ratio:16/9;object-fit:cover;background:#222"><div style="min-width:0"><b style="display:block;font-size:12px">${esc(item.clean||item.name)}</b><small style="color:var(--muted);font:9px var(--mono)">${esc(item.seasonLabel||'EPISODE')} · ${item.sizeMB?`${item.sizeMB} MB`:''}</small></div><span style="margin-left:auto;color:var(--accent)">▶</span></div>`).join('')}</div>`;}

    async function renderWishlist(token=routeToken){
      setMain(pageHead('My List',`${FAVS.length} saved title${FAVS.length===1?'':'s'} · Your personal watchlist.`,FAVS.length?'<button class="filter-select" id="clear-list">CLEAR ALL</button>':'')+`<div class="content-grid" id="wishlist-grid"><div class="loader"></div></div>`);
      if($('#clear-list'))$('#clear-list').onclick=()=>{FAVS=[];saveAll();$('#fav-count').textContent='0';renderWishlist(routeToken);};
      if(FAVS.some(fav=>!fav.tmdbId)&&!INDEX.length)await loadDriveRoot();if(token!==routeToken)return;
      const cards=[];for(const fav of FAVS){if(token!==routeToken)return;if(fav.tmdbId){try{const type=fav.mediaType==='tv'?'tv':'movie';const item=await tmdb(`${type}/${fav.tmdbId}`);if(token!==routeToken)return;item.media_type=type;cards.push(posterCard(item));}catch(error){if(token!==routeToken)return;cards.push(`<div class="poster-card"><div class="poster-frame"><img src="${placeholder(fav.clean)}" alt=""></div><div class="poster-info"><div class="poster-title">${esc(fav.clean)}</div><div class="poster-year">DETAILS UNAVAILABLE</div></div></div>`);}}else{let item=INDEX.find(entry=>entry.id===fav.id);if(!item){item=Object.assign({id:fav.id,name:fav.clean||fav.id,clean:fav.clean||fav.id,type:'video',kind:fav.kind||'movie'},analyzeName(fav.clean||fav.id,false));INDEX.push(item);}cards.push(driveCard(item));}}
      $('#wishlist-grid').innerHTML=cards.length?cards.join(''):showState('Your list is waiting','Save films and series to keep them close.',`<a class="btn btn-primary" href="./discover.html">Discover films</a>`);observeReveals();
    }

    async function renderDetails(id,type,token=routeToken){
      if(!id){setMain(showState('Title not found','The requested title could not be identified.'));return;}
      setMain(`<div class="detail-hero"><div class="detail-backdrop"></div><div class="detail-inner"><div class="skeleton skeleton-poster"></div><div><div class="eyebrow">LOADING TITLE</div><div class="loader" style="margin-left:0"></div></div></div></div>`);
      try{
        const item=await tmdb(`${type}/${id}`,{append_to_response:'credits,videos,recommendations,similar,external_ids'});if(token!==routeToken)return;item.media_type=type;
        if(!INDEX.length)await loadDriveRoot();
        if(type==='movie'&&CATS.movies){try{const movieRoot=await getFolder(CATS.movies);indexAdd((movieRoot.videos||[]).map(video=>{const a=analyzeName(video.name,false);return{id:video.id,name:video.name,clean:a.display,type:'video',kind:a.kind==='episode'?'movie':a.kind,season:a.season,episode:a.episode,year:a.year,sizeMB:video.sizeMB,dateAdded:video.dateAdded};}),CATS.movies);}catch(error){console.warn('Movie archive index unavailable:',error);}}
        if(type==='tv'&&CATS.series){try{const seriesRoot=await getFolder(CATS.series);indexAdd((seriesRoot.folders||[]).map(folder=>{const a=analyzeName(folder.name,true);return{id:folder.id,name:folder.name,clean:a.display,type:'folder',kind:a.kind,season:a.season};}),CATS.series);}catch(error){console.warn(error);}}
        if(token!==routeToken)return;
        const linked=await bestDriveMatch(item);if(token!==routeToken)return;const backdrop=image(item.backdrop_path,'original')||placeholder(mediaTitle(item),'16/9');const poster=image(item.poster_path)||placeholder(mediaTitle(item));
        const genres=(item.genres||[]).map(g=>g.name).join(' · ');const rating=item.vote_average?Number(item.vote_average).toFixed(1):'—';const year=mediaYear(item);const runtime=type==='movie'?runtimeLabel(item.runtime):`${item.number_of_seasons||0} season${item.number_of_seasons===1?'':'s'}`;
        const trailer=(item.videos?.results||[]).find(video=>video.site==='YouTube'&&video.type==='Trailer'&&video.official)|| (item.videos?.results||[]).find(video=>video.site==='YouTube'&&video.type==='Trailer');
        const cast=(item.credits?.cast||[]).slice(0,12);const similar=(item.recommendations?.results?.length?item.recommendations.results:item.similar?.results||[]).slice(0,12);
        const backdropNode=`<div class="detail-backdrop" style="background-image:url('${esc(backdrop)}')"></div>`;
        setMain(`<div class="breadcrumb"><a href="./index.html">HOME</a><span>/</span><a href="${type==='tv'?'./series.html':'./movies.html'}">${type==='tv'?'SERIES':'MOVIES'}</a><span>/</span>${esc(mediaTitle(item))}</div><section class="detail-hero">${backdropNode}<div class="detail-inner"><img class="detail-poster" src="${esc(poster)}" alt="${esc(mediaTitle(item))} poster" onerror="this.src='${placeholder(mediaTitle(item))}'"><div class="detail-copy"><div class="eyebrow">${type==='tv'?'SERIES PROFILE':'FEATURE PRESENTATION'}</div><h1>${esc(mediaTitle(item))}</h1><div class="detail-meta"><span class="rating">★ ${rating}/10</span><span>${esc(year||'TBA')}</span><span>${esc(runtime||'')}</span><span>${type==='tv'?'TV SERIES':'MOVIE'}</span></div><p class="detail-overview">${esc(item.overview||'No synopsis is available for this title yet.')}</p><div class="detail-actions">${linked?(linked.type==='folder'?`<a class="btn btn-primary" href="./archive.html?folder=${encodeURIComponent(linked.id)}">Open series archive ↗</a>`:`<a class="btn btn-primary" href="./watch.html?id=${encodeURIComponent(linked.id)}&title=${encodeURIComponent(mediaTitle(item))}"><svg viewBox="0 0 24 24"><path d="m8 5 11 7-11 7z"/></svg> Watch from archive</a>`):`<button class="btn btn-primary" disabled title="No matching archive item found">Not in your archive</button>`}${trailer?`<button class="btn btn-ghost" data-trailer="${esc(trailer.key)}">Watch trailer</button>`:''}<button class="btn btn-ghost" data-fav="${esc(mediaKey(item))}" data-fav-title="${esc(mediaTitle(item))}">${isFav(mediaKey(item))?'Saved to My List':'＋ My List'}</button></div></div></div></section><div class="detail-body"><div class="detail-columns"><div><h2 class="detail-section-title">The story</h2><p class="detail-overview" style="max-width:none">${esc(item.overview||'A story waiting to be discovered.')}</p>${cast.length?`<h2 class="detail-section-title" style="margin-top:35px">Cast & performances</h2><div class="cast-list">${cast.map(person=>`<div class="cast-card"><img src="${esc(image(person.profile_path,'w185')||placeholder(person.name))}" alt="${esc(person.name)}" loading="lazy"><b>${esc(person.name)}</b><small>${esc(person.character||'Cast')}</small></div>`).join('')}</div>`:''}</div><aside class="detail-side"><div class="side-row"><small>Genres</small><p>${esc(genres||'Not listed')}</p></div><div class="side-row"><small>Release date</small><p>${esc(dateLabel(item.release_date||item.first_air_date))}</p></div><div class="side-row"><small>Original language</small><p>${esc((item.original_language||'—').toUpperCase())}</p></div><div class="side-row"><small>Popularity</small><p>${item.popularity?Number(item.popularity).toFixed(0):'—'}</p></div>${type==='movie'?`<div class="side-row"><small>Runtime</small><p>${esc(runtime||'—')}</p></div>`:`<div class="side-row"><small>Episodes</small><p>${item.number_of_episodes||'—'}</p></div>`}<div class="side-row"><small>Archive availability</small><p>${linked?(linked.type==='folder'?'Series folder available in your Google Drive archive':'Movie file available in your Google Drive archive'):'No verified matching file found'}</p></div></aside></div>${similar.length?section('More to explore','Because one good story leads to another',similar):''}</div>`);
        observeReveals();
      }catch(error){if(token===routeToken)setMain(showState('Could not load this title',error.message||'TMDB could not return the requested details.'));}
    }


    async function renderSearchPage(initialQuery='',token=routeToken){
      const query=String(initialQuery||'').trim();
      setMain(pageHead('Search the collection','Find a film, a series, a director, or something already in your archive.')+
        `<form class="search-page-tools" id="page-search-form"><label class="sr-only" for="page-search-input">Search films and series</label><input id="page-search-input" type="search" value="${esc(query)}" placeholder="What would you like to watch?" autocomplete="off"><button class="btn btn-accent" type="submit">Search titles</button></form><div class="content-grid search-page-results" id="search-page-results"><div class="loader"></div></div>`);
      const form=$('#page-search-form');form.addEventListener('submit',event=>{event.preventDefault();location.href=`./search.html?q=${encodeURIComponent($('#page-search-input').value.trim())}`;});
      if(!query){$('#search-page-results').innerHTML=showState('A story begins with a search','Enter a title above to explore TMDB and your connected archive.');return;}
      if(!INDEX.length)await loadDriveRoot();if(token!==routeToken)return;
      let remote=[];try{const data=await tmdb('search/multi',{query,include_adult:'false'});remote=(data.results||[]).filter(item=>['movie','tv'].includes(item.media_type));}catch(error){console.warn('Search page TMDB request failed:',error);}
      const local=INDEX.filter(item=>norm(item.clean||item.name).includes(norm(query))).slice(0,18);
      const cards=remote.map(item=>posterCard(item));
      local.forEach(item=>{const label=norm(item.clean||item.name);if(!remote.some(result=>norm(mediaTitle(result))===label))cards.push(driveCard(item,item.type==='folder'));});
      if(token!==routeToken)return;
      $('#search-page-results').innerHTML=cards.length?cards.join(''):showState('No titles found','Try another spelling or a broader search.');observeReveals();
    }

    async function renderWatchPage(id,title='',token=routeToken){
      if(!id||!/^[a-zA-Z0-9_-]+$/.test(String(id))){setMain(showState('Watch link unavailable','This page needs a valid Google Drive file ID.'));return;}
      if(!INDEX.length)await loadDriveRoot();if(token!==routeToken)return;
      if(CATS.movies){try{const movieRoot=await getFolder(CATS.movies);indexAdd((movieRoot.videos||[]).map(video=>{const a=analyzeName(video.name,false);return{id:video.id,name:video.name,clean:a.display,type:'video',kind:a.kind==='episode'?'movie':a.kind,season:a.season,episode:a.episode,year:a.year,sizeMB:video.sizeMB,dateAdded:video.dateAdded};}),CATS.movies);}catch(error){console.warn('Could not hydrate the movie archive:',error);}}
      let item=INDEX.find(entry=>entry.id===id);
      if(!item){
        // A previously saved title may still be valid if the user has not opened its parent folder in this browser yet.
        const prior=HISTORY.find(entry=>entry.id===id)||FAVS.find(entry=>entry.id===id);
        if(prior){item={id,name:prior.name||prior.clean||title||id,clean:prior.clean||prior.name||title||id,type:'video',kind:prior.kind||'movie'};INDEX.push(item);}
      }
      if(!item||item.type==='folder'){setMain(showState('No verified archive match','This file is not present in the indexed Google Drive collection. Open its parent archive folder first, then try again.','<a class="btn btn-primary" href="./archive.html">Open archive</a>'));return;}
      const name=item.clean||item.name||title||'T MOVIES feature';
      HISTORY=[{id:item.id,name:item.name||name,sizeMB:item.sizeMB,t:Date.now()}].concat(HISTORY.filter(entry=>entry.id!==id)).slice(0,12);saveAll();
      setMain(`<section class="watch-page"><div class="eyebrow">T MOVIES · PRIVATE ARCHIVE</div><h1>${esc(name)}</h1><p class="watch-note">Your existing Google Drive file is being opened. The original file association is unchanged.</p><div class="watch-screen"><iframe src="https://drive.google.com/file/d/${encodeURIComponent(id)}/preview" title="${esc(name)}" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div><div class="watch-actions"><a class="btn btn-accent" href="https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}" target="_blank" rel="noopener">Download from Drive ↗</a><a class="btn btn-ghost" href="./archive.html">Back to archive</a></div><p class="watch-note">Playback and download availability depend on the existing Google Drive sharing permissions.</p></section>`);
    }

    function openSearch(){const overlay=$('#search-overlay');overlay.classList.add('open');document.body.classList.add('locked');setTimeout(()=>$('#search-input').focus(),60);}
    function closeSearch(){const overlay=$('#search-overlay');overlay.classList.remove('open');if(!$('#modal-overlay').classList.contains('open')&&!$('#player-overlay').classList.contains('open'))document.body.classList.remove('locked');}
    function closeModal(){ $('#modal-overlay').classList.remove('open'); if(!$('#search-overlay').classList.contains('open')&&!$('#player-overlay').classList.contains('open'))document.body.classList.remove('locked'); }
    function openModal(item,art){const title=item.clean||item.name||'Archive item';const img=art?.bo||art?.b||art?.p||placeholder(title,'16/9');$('#modal-content').innerHTML=`<div class="eyebrow">YOUR ARCHIVE</div><h2>${esc(title)}</h2><p>${esc(art?.title?`Matched with TMDB title: ${art.title}.`:'This item is part of your existing Google Drive archive.')}${item.sizeMB?` File size: ${item.sizeMB} MB.`:''}</p><div class="modal-actions">${item.type==='folder'?`<button class="btn btn-primary" data-modal-browse="${esc(item.id)}">Open folder</button>`:`<button class="btn btn-primary" data-modal-play="${esc(item.id)}">Watch now</button>`}<button class="btn btn-ghost" data-fav="${esc(item.id)}">${isFav(item.id)?'Saved':'＋ My List'}</button></div>`;$('#modal-overlay').classList.add('open');document.body.classList.add('locked');}
    async function runSearch(query){const q=query.trim();const box=$('#search-results');if(q.length<2){box.innerHTML='';$('#search-hint').textContent='START TYPING TO EXPLORE THE COLLECTION';return;}$('#search-hint').textContent='SEARCHING FILMS, SERIES AND YOUR ARCHIVE…';
      const local=INDEX.filter(item=>norm(item.clean||item.name).includes(norm(q))).slice(0,8);let remote=[];try{const data=await tmdb('search/multi',{query:q,include_adult:'false'});remote=(data.results||[]).filter(item=>['movie','tv'].includes(item.media_type)).slice(0,16);}catch(error){console.warn('Search API unavailable:',error);}
      const results=remote.map(item=>({item,local:false}));local.forEach(item=>{if(!results.some(r=>norm(mediaTitle(r.item))===norm(item.clean||item.name)))results.push({item: {id:item.id,title:item.clean||item.name,media_type:'archive',poster_path:null,year:item.year},local:true});});
      $('#search-hint').innerHTML=results.length?`${results.length} RESULTS · SELECT A TITLE TO EXPLORE · <a href="./search.html?q=${encodeURIComponent(q)}" style="color:var(--accent)">SEE ALL RESULTS ↗</a>`:'NO MATCHES FOUND';box.innerHTML=results.map(({item,local})=>local?`<div class="search-result" data-drive-item="${esc(item.id)}"><img src="${placeholder(item.title)}" alt=""><b>${esc(item.title)}</b><small>YOUR ARCHIVE</small></div>`:`<div class="search-result" data-open-media="${esc(mediaType(item))}:${esc(item.id)}"><img src="${esc(image(item.poster_path)||placeholder(mediaTitle(item)))}" alt="${esc(mediaTitle(item))}" loading="lazy"><b>${esc(mediaTitle(item))}</b><small>${esc(mediaYear(item)||'')} · ${mediaType(item)==='tv'?'SERIES':'FILM'}</small></div>`).join('');
    }
    let searchTimer=null;$('#search-input').addEventListener('input',event=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>runSearch(event.target.value),260);});

    function openDrivePlayer(id){let item=INDEX.find(entry=>entry.id===id);if(!item){const prior=HISTORY.find(entry=>entry.id===id)||FAVS.find(entry=>entry.id===id);if(prior){item=Object.assign({id,name:prior.name||prior.clean||id,clean:prior.clean||prior.name||id,type:'video',kind:prior.kind||'movie'},analyzeName(prior.name||prior.clean||id,false));INDEX.push(item);}}if(!item){toast('This archive item is no longer indexed. Refresh the folder.');return;}if(!/^[a-zA-Z0-9_-]+$/.test(String(id))){toast('This Drive file ID is not valid.');return;}const title=item.clean||item.name;HISTORY=[{id:item.id,name:item.name||title,sizeMB:item.sizeMB,t:Date.now()}].concat(HISTORY.filter(h=>h.id!==id)).slice(0,12);saveAll();$('#player-title').textContent=`NOW PLAYING · ${title.toUpperCase()}`;$('#player-frame').innerHTML=`<iframe src="https://drive.google.com/file/d/${encodeURIComponent(id)}/preview" title="${esc(title)}" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;$('#player-note').innerHTML=`Playback is provided by your existing Google Drive file. <a href="https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}" target="_blank" rel="noopener" style="color:var(--gold);margin-left:6px">Download file ↗</a>`;$('#player-overlay').classList.add('open');document.body.classList.add('locked');}
    function openTrailer(key){if(!/^[a-zA-Z0-9_-]+$/.test(String(key)))return;$('#player-title').textContent='OFFICIAL TRAILER';$('#player-frame').innerHTML=`<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(key)}?autoplay=1&rel=0" title="Official movie trailer" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>`;$('#player-note').textContent='Trailer provided by YouTube. Availability may vary by region.';$('#player-overlay').classList.add('open');document.body.classList.add('locked');}
    function closePlayer(){ $('#player-overlay').classList.remove('open');$('#player-frame').innerHTML='';if(!$('#search-overlay').classList.contains('open')&&!$('#modal-overlay').classList.contains('open'))document.body.classList.remove('locked'); }
    function closeMobileMenu(){ $('#mobile-menu').classList.remove('open');$('#menu-toggle').setAttribute('aria-expanded','false'); }

    function observeReveals(){const nodes=$$('.reveal');if(!('IntersectionObserver'in window)){nodes.forEach(node=>node.classList.add('visible'));return;}const observer=new IntersectionObserver(entries=>entries.forEach(entry=>{if(entry.isIntersecting){entry.target.classList.add('visible');observer.unobserve(entry.target);}}),{threshold:.08});nodes.forEach(node=>observer.observe(node));}
    const topbar=$('#topbar');
    const finePointer=matchMedia('(hover:hover) and (pointer:fine)').matches;
    const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)').matches;
    let scrollFrame=0;
    window.addEventListener('scroll',()=>{
      if(scrollFrame)return;
      scrollFrame=requestAnimationFrame(()=>{
        scrollFrame=0;
        topbar.classList.toggle('scrolled',window.scrollY>28);
        const hero=$('.hero'),orbit=$('.hero-orbit');
        if(orbit&&window.scrollY<1100)orbit.style.transform=`translate3d(0,${window.scrollY*-.075}px,0) rotate(${-24+window.scrollY*.045}deg)`;
        if(hero){
          const depth=Math.min(window.scrollY/900,1);
          hero.style.setProperty('--hero-scroll',depth);
          $$('.hero-character-card',hero).forEach((card,index)=>{
            card.style.setProperty('--scroll-shift',`${window.scrollY*(.025+(index*.012))}px`);
            card.style.setProperty('--scroll-rotate',`${(index%2?1:-1)*depth*(index+1)*1.4}deg`);
          });
        }
        $$('.cinema-wall-tile').forEach((tile,index)=>{
          tile.style.setProperty('--scroll-shift',`${Math.sin((window.scrollY*.001)+(index*.6))*12}px`);
        });
      });
    },{passive:true});

    if(finePointer&&!reducedMotion){
      const glow=$('.cursor-glow');let pointerFrame=0,lastPointer=null;
      document.addEventListener('pointermove',event=>{
        lastPointer=event;if(pointerFrame)return;
        pointerFrame=requestAnimationFrame(()=>{
          pointerFrame=0;if(!lastPointer)return;
          const x=lastPointer.clientX,y=lastPointer.clientY;
          if(glow){glow.style.setProperty('--x',`${x}px`);glow.style.setProperty('--y',`${y}px`);glow.classList.add('active');}
          $$('.cinema-wall-tile').forEach((tile,index)=>{
            const drift=(x/window.innerWidth-.5)*(index%2?1:-1)*(5+(index%4)*2);
            tile.style.setProperty('--pointer-shift',`${drift}px`);
          });
          const hero=$('.hero');
          if(hero&&y<window.innerHeight*1.3){
            const px=(x/window.innerWidth-.5)*22,py=(y/window.innerHeight-.5)*14;
            hero.style.setProperty('--hero-pointer-x',`${px}px`);hero.style.setProperty('--hero-pointer-y',`${py}px`);
            const copy=$('.hero-copy',hero);if(copy)copy.style.transform=`translate3d(${px*.22}px,${py*.2}px,0)`;
          }
          const card=lastPointer.target.closest?.('.poster-card');
          if(card){const rect=card.getBoundingClientRect();const rx=((x-rect.left)/rect.width-.5),ry=((y-rect.top)/rect.height-.5);card.style.setProperty('--tilt-x',`${rx*4.5}deg`);card.style.setProperty('--tilt-y',`${-ry*4.5}deg`);}
          const button=lastPointer.target.closest?.('.btn,.quick-btn');
          if(button){const rect=button.getBoundingClientRect();const dx=(x-(rect.left+rect.width/2))/rect.width,dy=(y-(rect.top+rect.height/2))/rect.height;button.style.transform=`translate3d(${dx*5}px,${dy*4}px,0)`;}
        });
      },{passive:true});
      document.addEventListener('pointerout',event=>{
        if(event.target.matches?.('.btn,.quick-btn'))event.target.style.transform='';
        const card=event.target.closest?.('.poster-card');if(card&&!card.contains(event.relatedTarget)){card.style.removeProperty('--tilt-x');card.style.removeProperty('--tilt-y');}
      });
      document.addEventListener('pointerleave',()=>{if(glow)glow.classList.remove('active');});
    }
    document.addEventListener('load',event=>{if(event.target instanceof HTMLImageElement)event.target.classList.add('is-loaded');},true);

    // Centralized interactions: works for dynamically rendered cards and page sections.
    document.addEventListener('click',event=>{
      const target=event.target.closest('[data-open-media],[data-drive-item],[data-drive-play],[data-fav],[data-card-info],[data-browse],[data-genre],[data-watch-drive],[data-trailer],[data-modal-play],[data-modal-browse],[data-ep-view]');if(!target)return;
      if(target.dataset.fav){event.stopPropagation();const raw=target.dataset.fav;let item;if(raw.startsWith('tmdb:')){const [,type,id]=raw.split(':');item={id:raw,tmdbId:Number(id),mediaType:type,kind:type,clean:target.dataset.favTitle||target.closest('.poster-card')?.querySelector('.poster-title')?.textContent||'Saved title'};}else{const existing=INDEX.find(entry=>entry.id===raw);item=existing||{id:raw,clean:raw};}toggleFav(item);if($('#modal-content')?.querySelector(`[data-fav="${CSS.escape(raw)}"]`))$('#modal-content').querySelector(`[data-fav="${CSS.escape(raw)}"]`).textContent=isFav(raw)?'Saved':'＋ My List';return;}
      if(target.dataset.openMedia){const [type,id]=target.dataset.openMedia.split(':');location.href=`./${type==='tv'?'series-details':'movie'}.html?id=${encodeURIComponent(id)}`;return;}
      if(target.dataset.cardInfo){const [type,id]=target.dataset.cardInfo.split(':');location.href=`./${type==='tv'?'series-details':'movie'}.html?id=${encodeURIComponent(id)}`;return;}
      if(target.dataset.drivePlay){event.stopPropagation();openDrivePlayer(target.dataset.drivePlay);return;}
      if(target.dataset.driveItem){const item=INDEX.find(entry=>entry.id===target.dataset.driveItem);if(item){if(item.type==='folder'){location.href=`./archive.html?folder=${encodeURIComponent(item.id)}`;}else{const art=artCache[`art2:${item.kind}|${norm(item.clean||item.sq||item.name)}|${item.season??''}|${item.episode??''}`];openModal(item,art);}}return;}
      if(target.dataset.browse){location.href=`./archive.html?folder=${encodeURIComponent(target.dataset.browse)}`;return;}
      if(target.dataset.genre){const name=target.closest('.genre-tile')?.querySelector('span')?.textContent||'';location.href=`./genre.html?id=${encodeURIComponent(target.dataset.genre)}&name=${encodeURIComponent(name)}`;return;}
      if(target.dataset.watchDrive){location.href=`./watch.html?id=${encodeURIComponent(target.dataset.watchDrive)}`;return;}
      if(target.dataset.trailer){openTrailer(target.dataset.trailer);return;}
      if(target.dataset.modalPlay){closeModal();openDrivePlayer(target.dataset.modalPlay);return;}
      if(target.dataset.modalBrowse){location.href=`./archive.html?folder=${encodeURIComponent(target.dataset.modalBrowse)}`;return;}
      if(target.dataset.epView){epView=target.dataset.epView;store(KEYS.epview,epView);renderEpisodes();return;}
    });
    document.addEventListener('keydown',event=>{
      if(event.key==='Escape'){closeSearch();closeModal();closePlayer();closeMobileMenu();}
      if(event.key==='/'&&!['INPUT','TEXTAREA'].includes(document.activeElement.tagName)){event.preventDefault();openSearch();}
      if((event.key==='Enter'||event.key===' ')&&event.target.matches('[data-open-media],[data-drive-item]')){event.preventDefault();event.target.click();}
    });
    $('#refresh-art').addEventListener('click',()=>{artCache={};tmdbCache={};saveAll();toast('Artwork cache cleared. Refreshing…');route();});
    $('#search-open').addEventListener('click',openSearch);$('#search-close').addEventListener('click',closeSearch);$('#search-overlay').addEventListener('click',event=>{if(event.target.id==='search-overlay')closeSearch();});
    $('#modal-close').addEventListener('click',closeModal);$('#modal-overlay').addEventListener('click',event=>{if(event.target.id==='modal-overlay')closeModal();});
    $('#player-close').addEventListener('click',closePlayer);$('#player-overlay').addEventListener('click',event=>{if(event.target.id==='player-overlay')closePlayer();});
    $('#menu-toggle').addEventListener('click',()=>{const menu=$('#mobile-menu');const open=!menu.classList.contains('open');menu.classList.toggle('open',open);$('#menu-toggle').setAttribute('aria-expanded',String(open));});
    $('#mobile-menu').addEventListener('click',event=>{if(event.target.closest('a'))closeMobileMenu();});
    $('#year-now').textContent=new Date().getFullYear();$('#fav-count').textContent=FAVS.length;
    loadCinematicWall();
    route();
  })();
