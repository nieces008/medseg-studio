/* ============================================================
 * MedSeg Studio · 分割引擎与交互
 * 区域生长 / Otsu / CAD筛查 / 画笔精修 / 窗宽窗位 / 卷帘对比
 * 定量测量 / Dice·IoU / RECIST随访 / 报告导出
 * ============================================================ */

let S = null;                 // 当前样本
let mask = null;              // 当前分割掩膜
let tool = 'seed';            // seed | brush | erase | pan
let ww = 255, wl = 128;
let brushR = 10, tolerance = 42, cadOffset = 0, minArea = 80;
let otsuT = 175;
let layer = { mask:true, contour:true, recist:true, gold:false };
let maskOpacity = 0.45;
let splitPct = -1;            // 卷帘：-1关闭
let undoStack = [];
let cadList = [];
let hoverInfo = { x:-1, y:-1 };

const cv = document.getElementById('mainCanvas');
const ctx = cv.getContext('2d');
const W = 512, H = 512;
cv.width = W; cv.height = H;

// 离屏合成
const baseCv = document.createElement('canvas'); baseCv.width=W; baseCv.height=H;
const baseCtx = baseCv.getContext('2d');

// ---------------- 样本装载 ----------------
function loadSample(id) { applySample(getSample(id)); }
function applySample(s) {
    S = s;
    smoothCache = null;
    mask = new Uint8Array(W*H);
    undoStack = []; cadList = [];
    ww = S.defaultWW; wl = S.defaultWL;
    document.getElementById('wwRange').value = ww;
    document.getElementById('wlRange').value = wl;
    document.getElementById('wwVal').textContent = ww;
    document.getElementById('wlVal').textContent = wl;
    document.getElementById('polarity').value = S.polarity;
    document.getElementById('mmPerPx').value = S.mmPerPx;
    document.getElementById('sampleTitle').textContent = S.name + '（' + S.modality + '）';
    document.getElementById('sampleFinding').textContent = S.finding;
    document.getElementById('sampleMeta').textContent =
        `${S.modality} · 512×512 · ${S.mmPerPx}mm/px` + (S.gold ? ' · 合成教学样本' : ' · 用户导入');
    document.querySelectorAll('.sample-tab').forEach(t =>
        t.classList.toggle('active', t.dataset.id === S.id));
    document.getElementById('abcdPanel').style.display = S.rgb ? 'block':'none';
    render(); measure(); renderFollowups();
}

// ---------------- 用户导入影像 ----------------
function handleUpload(input) {
    const file = input.files[0]; if (!file) return;
    const img = new Image();
    img.onload = () => {
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const cx = c.getContext('2d');
        cx.fillStyle = '#000'; cx.fillRect(0,0,W,H);
        const scale = Math.min(W/img.width, H/img.height);
        const dw = img.width*scale, dh = img.height*scale;
        cx.drawImage(img, (W-dw)/2, (H-dh)/2, dw, dh);
        const data = cx.getImageData(0,0,W,H).data;
        const s = blankSample({ id:'upload', name:file.name, desc:'用户导入',
            mmPerPx:1, polarity:'bright', modality:'导入影像',
            defaultWW:255, defaultWL:128,
            finding:'用户导入影像。请先设置空间标定(mm/px)，再点击病灶分割测量；无金标准时重叠度指标不可用。' });
        s.gold = null;
        s.rgb = new Uint8ClampedArray(W*H*3);
        for (let i=0;i<W*H;i++) {
            const r=data[i*4], g=data[i*4+1], b=data[i*4+2];
            s.rgb[i*3]=r; s.rgb[i*3+1]=g; s.rgb[i*3+2]=b;
            s.gray[i]=0.299*r+0.587*g+0.114*b;
        }
        s.seed=[W>>1,H>>1];
        applySample(s);
        toast('影像已导入，点击病灶进行分割');
    };
    img.src = URL.createObjectURL(file);
    input.value = '';
}

// ---------------- 预处理：可分离高斯平滑（仅用于分割，渲染仍用原图） ----------------
let smoothCache = null;
function gaussianSmooth(src) {
    const k = [1,4,6,4,1];
    const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
    for (let y=0;y<H;y++) for (let x=0;x<W;x++) {
        let s=0;
        for (let d=-2;d<=2;d++) s += src[y*W+Math.min(W-1,Math.max(0,x+d))]*k[d+2];
        tmp[y*W+x]=s/16;
    }
    for (let y=0;y<H;y++) for (let x=0;x<W;x++) {
        let s=0;
        for (let d=-2;d<=2;d++) s += tmp[Math.min(H-1,Math.max(0,y+d))*W+x]*k[d+2];
        out[y*W+x]=s/16;
    }
    return out;
}
function grayForSeg() {
    const on = document.getElementById('smoothPre').checked;
    if (!on) return S.gray;
    if (!smoothCache) smoothCache = gaussianSmooth(S.gray);
    return smoothCache;
}

// ---------------- 窗宽窗位 & 基础渲染 ----------------
function applyWindow(v) {
    const lo = wl - ww/2;
    return Math.max(0, Math.min(255, (v-lo)/ww*255));
}
function renderBase() {
    const img = baseCtx.createImageData(W,H);
    for (let i=0;i<W*H;i++) {
        if (S.rgb) {                       // 彩色样本：原色显示
            img.data[i*4]=S.rgb[i*3]; img.data[i*4+1]=S.rgb[i*3+1];
            img.data[i*4+2]=S.rgb[i*3+2];
        } else {
            const v = applyWindow(S.gray[i]);
            img.data[i*4]=v; img.data[i*4+1]=v; img.data[i*4+2]=v;
        }
        img.data[i*4+3]=255;
    }
    baseCtx.putImageData(img,0,0);
}

function render() {
    renderBase();
    ctx.drawImage(baseCv,0,0);
    if (splitPct >= 0) {                   // 卷帘：右侧画分割版
        drawSegView(0,0,W,H,0);
        ctx.drawImage(baseCv,0,0,W,H,0,0,W*splitPct/100,H);
        ctx.fillStyle='#00d4ff';
        ctx.fillRect(W*splitPct/100-1,0,2,H);
    } else {
        drawSegView(0,0,W,H,0);
    }
    if (layer.recist) drawRecistLine();
    if (hoverInfo.x>=0) updateHover();
}

// 分割叠加（掩膜+轮廓+金标准）
function drawSegView() {
    if (!S) return;
    if (layer.mask && mask) {
        const img = ctx.getImageData(0,0,W,H);
        for (let i=0;i<W*H;i++) if (mask[i]) {
            img.data[i*4]   = img.data[i*4]*(1-maskOpacity)+0*maskOpacity;
            img.data[i*4+1] = img.data[i*4+1]*(1-maskOpacity)+212*maskOpacity;
            img.data[i*4+2] = img.data[i*4+2]*(1-maskOpacity)+255*maskOpacity;
        }
        ctx.putImageData(img,0,0);
    }
    if (layer.contour && mask) drawContour(mask,'#ff4d5e',1.5);
    if (layer.gold && S.gold) drawContour(S.gold,'#48bb78',1.2);
    // CAD候选框
    cadList.forEach((c,idx) => {
        if (!c.selected) return;
        ctx.strokeStyle='#fac858'; ctx.lineWidth=1.5;
        ctx.strokeRect(c.bbox[0]-4,c.bbox[1]-4,c.bbox[2]-c.bbox[0]+8,c.bbox[3]-c.bbox[1]+8);
        ctx.fillStyle='#fac858'; ctx.font='12px monospace';
        ctx.fillText('#L'+(idx+1), c.bbox[0], c.bbox[1]-8);
    });
}
function drawContour(m,color,lw) {
    ctx.strokeStyle=color; ctx.lineWidth=lw; ctx.beginPath();
    for (let y=1;y<H-1;y++) for (let x=1;x<W-1;x++) {
        const i=y*W+x;
        if (m[i] && (!m[i-1]||!m[i+1]||!m[i-W]||!m[i+W])) {
            ctx.moveTo(x-0.5,y-0.5); ctx.lineTo(x+0.5,y-0.5);
            ctx.moveTo(x-0.5,y+0.5); ctx.lineTo(x+0.5,y+0.5);
            ctx.moveTo(x-0.5,y-0.5); ctx.lineTo(x-0.5,y+0.5);
            ctx.moveTo(x+0.5,y-0.5); ctx.lineTo(x+0.5,y+0.5);
        }
    }
    ctx.stroke();
}
function drawRecistLine() {
    const m = computeMeasure(mask);
    if (!m || !m.diamLine) return;
    const [a,b] = m.diamLine;
    ctx.strokeStyle='#fac858'; ctx.lineWidth=2;
    ctx.beginPath(); ctx.moveTo(a[0],a[1]); ctx.lineTo(b[0],b[1]); ctx.stroke();
    ctx.fillStyle='#fac858'; ctx.font='bold 13px monospace';
    ctx.fillText(m.longDiam.toFixed(1)+'mm', (a[0]+b[0])/2+8, (a[1]+b[1])/2);
}

// ---------------- 分割算法 ----------------
// 自适应区域生长：种子邻域统计 + 动态区域均值 + 8邻域
function regionGrow(sx,sy) {
    const g = grayForSeg();
    const adaptive = document.getElementById('adaptiveGrow').checked;
    // 种子 9×9 邻域局部统计
    let mean=0, sq=0, n=0;
    for (let dy=-4;dy<=4;dy++) for (let dx=-4;dx<=4;dx++) {
        const nx=sx+dx, ny=sy+dy;
        if(nx<0||ny<0||nx>=W||ny>=H) continue;
        const v=g[ny*W+nx]; mean+=v; sq+=v*v; n++;
    }
    mean/=n;
    const std=Math.sqrt(Math.max(0,sq/n-mean*mean));
    const base = adaptive ? mean : g[sy*W+sx];
    // 自适应容差：局部标准差驱动，不低于用户容差的一半
    const dynTol = adaptive ? Math.max(tolerance*0.5, std*2.5) : tolerance;
    const m=new Uint8Array(W*H), visited=new Uint8Array(W*H);
    const stack=[sy*W+sx]; visited[sy*W+sx]=1;
    let regionMean=base, count=0;
    while (stack.length) {
        const p=stack.pop();
        const v=g[p];
        if (Math.abs(v-base) > dynTol) continue;
        if (count>20 && Math.abs(v-regionMean) > dynTol) continue;  // 区域同质性约束
        m[p]=1;
        count++; regionMean += (v-regionMean)/count;               // 增量均值
        const x=p%W, y=(p/W)|0;
        for (let dy=-1;dy<=1;dy++) for (let dx=-1;dx<=1;dx++) {
            if(!dx&&!dy) continue;
            const nx=x+dx, ny=y+dy;
            if(nx<0||ny<0||nx>=W||ny>=H) continue;
            const q=ny*W+nx;
            if(!visited[q]){visited[q]=1;stack.push(q);}
        }
    }
    return m;
}

function otsuThreshold() {
    const g = grayForSeg();
    const hist=new Array(256).fill(0);
    for (let i=0;i<W*H;i++) hist[Math.round(g[i])]++;
    // 直方图高斯平滑，抑制毛刺导致的阈值抖动
    const k=[1,4,6,4,1];
    const hs=hist.map((_,i)=>{
        let s=0;
        for(let d=-2;d<=2;d++) s+=hist[Math.min(255,Math.max(0,i+d))]*k[d+2];
        return s/16;
    });
    let sum=0; for(let i=0;i<256;i++) sum+=i*hs[i];
    let sumB=0,wB=0,maxV=0,thr=128;
    for(let t=0;t<256;t++){
        wB+=hs[t]; if(!wB) continue;
        const wF=W*H-wB; if(!wF) break;
        sumB+=t*hs[t];
        const mB=sumB/wB,mF=(sum-sumB)/wF;
        const v=wB*wF*(mB-mF)*(mB-mF);
        if(v>maxV){maxV=v;thr=t;}
    }
    return thr;
}
function otsuSegment() {
    const T=otsuT, bright=S.polarity==='bright';
    const g=grayForSeg();
    let m=new Uint8Array(W*H);
    for(let i=0;i<W*H;i++) m[i]= bright ? g[i]>T : g[i]<T ? 1:0;
    if (document.getElementById('largestOnly').checked) m=largestCC(m);
    pushUndo(); mask=m; afterSeg('Otsu T='+T);
}
function autoOtsu(){ otsuT=otsuThreshold();
    document.getElementById('otsuRange').value=otsuT;
    document.getElementById('otsuVal').textContent=otsuT; otsuSegment(); }

function connectedComponents(m) {
    const label=new Int32Array(W*H).fill(-1); const comps=[];
    for(let i=0;i<W*H;i++){
        if(!m[i]||label[i]>=0) continue;
        const id=comps.length;
        const stack=[i]; label[i]=id; const pts=[];
        while(stack.length){
            const p=stack.pop(); pts.push(p);
            const x=p%W,y=(p/W)|0;
            [[1,0],[-1,0],[0,1],[0,-1]].forEach(([dx,dy])=>{
                const nx=x+dx,ny=y+dy;
                if(nx<0||ny<0||nx>=W||ny>=H)return;
                const q=ny*W+nx;
                if(m[q]&&label[q]<0){label[q]=id;stack.push(q);}
            });
        }
        comps.push(pts);
    }
    return comps;
}
function largestCC(m) {
    const comps=connectedComponents(m);
    if(!comps.length) return m;
    comps.sort((a,b)=>b.length-a.length);
    const out=new Uint8Array(W*H);
    comps[0].forEach(p=>out[p]=1);
    return out;
}
function morphClose(m) {
    return erode(dilate(m));
}
function dilate(m){const r=new Uint8Array(W*H);
    for(let y=1;y<H-1;y++)for(let x=1;x<W-1;x++){let v=0;
        for(let dy=-1;dy<=1&&!v;dy++)for(let dx=-1;dx<=1;dx++)
            if(m[(y+dy)*W+x+dx]){v=1;break;}
        r[y*W+x]=v;}return r;}
function erode(m){const r=new Uint8Array(W*H);
    for(let y=1;y<H-1;y++)for(let x=1;x<W-1;x++){let v=1;
        for(let dy=-1;dy<=1&&v;dy++)for(let dx=-1;dx<=1;dx++)
            if(!m[(y+dy)*W+x+dx]){v=0;break;}
        r[y*W+x]=v;}return r;}
function fillHoles(m) {
    // 从边界洪水填充背景，未到达的背景即孔洞
    const bg=new Uint8Array(W*H); const stack=[];
    for(let x=0;x<W;x++){stack.push(x,(H-1)*W+x);}
    for(let y=0;y<H;y++){stack.push(y*W,y*W+W-1);}
    const seen=new Uint8Array(W*H);
    while(stack.length){
        const p=stack.pop();
        if(seen[p]||m[p])continue;
        seen[p]=1;bg[p]=1;
        const x=p%W,y=(p/W)|0;
        [[1,0],[-1,0],[0,1],[0,-1]].forEach(([dx,dy])=>{
            const nx=x+dx,ny=y+dy;
            if(nx>=0&&ny>=0&&nx<W&&ny<H)stack.push(ny*W+nx);
        });
    }
    const out=new Uint8Array(W*H);
    for(let i=0;i<W*H;i++) out[i]= (m[i]||!bg[i])?1:0;
    return out;
}

// ---------------- CAD 自动筛查 ----------------
function runCAD() {
    const bright=S.polarity==='bright';
    const g=grayForSeg();
    // 以 Otsu 最优阈值为基准，灵敏度偏移在其上调节
    const baseT=otsuThreshold();
    const T= bright ? baseT-cadOffset : baseT+cadOffset;
    let m=new Uint8Array(W*H);
    for(let i=0;i<W*H;i++) m[i]= bright?g[i]>T:g[i]<T?1:0;
    const comps=connectedComponents(m).filter(c=>c.length>=minArea);
    cadList=comps.map(pts=>{
        const mm=maskFromPts(pts);
        const meas=computeMeasure(mm);
        // 病灶-周围环对比度
        const ring=dilate(dilate(mm));
        let rSum=0,rN=0,lSum=0;
        for(let i=0;i<W*H;i++){
            if(mm[i])lSum+=S.gray[i];
            else if(ring[i]){rSum+=S.gray[i];rN++;}
        }
        const contrast=(lSum/pts.length)-(rN?rSum/rN:0);
        // 多维启发式评分：对比度 + 圆度 + 尺寸（非统计概率）
        const circ=c_meas_circ(mm);
        return {pts,mask:mm,meas,contrast,
            bbox:meas?meas.bbox:[0,0,0,0],selected:false,
            conf:Math.min(99,Math.round(45+Math.abs(contrast)/4+circ*20+Math.min(10,pts.length/200)))};
    }).filter(c=>c.meas);
    cadList.sort((a,b)=>b.pts.length-a.pts.length);
    cadList=cadList.slice(0,5);
    if(cadList.length){
        cadList[0].selected=true;
        pushUndo(); mask=cadList[0].mask.slice();
    }
    renderCADTable(); render(); measure();
    toast(`CAD 检出 ${cadList.length} 个候选病灶`);
}
function maskFromPts(pts){const m=new Uint8Array(W*H);pts.forEach(p=>m[p]=1);return m;}
function c_meas_circ(mm){const ms=computeMeasure(mm);return ms?ms.circularity:0.5;}

// ---------------- 后处理优化：多数滤波边缘平滑 + 小连通域去碎斑 ----------------
function majorityFilter(m) {
    const out=new Uint8Array(W*H);
    for(let y=0;y<H;y++)for(let x=0;x<W;x++){
        let cnt=0;
        for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
            const nx=x+dx,ny=y+dy;
            if(nx>=0&&ny>=0&&nx<W&&ny<H&&m[ny*W+nx])cnt++;
        }
        out[y*W+x]=cnt>=5?1:0;
    }
    return out;
}
function removeSmall(m) {
    const comps=connectedComponents(m);
    if(comps.length<=1) return m;
    comps.sort((a,b)=>b.length-a.length);
    const maxN=comps[0].length;
    const out=new Uint8Array(W*H);
    comps.forEach(c=>{
        if(c.length>=Math.max(20,maxN*0.05)) c.forEach(p=>out[p]=1);
    });
    return out;
}

function renderCADTable() {
    const tb=document.getElementById('cadBody');
    if(!cadList.length){tb.innerHTML='<tr><td colspan="5" class="dim">暂无候选</td></tr>';return;}
    tb.innerHTML=cadList.map((c,i)=>`<tr class="${c.selected?'sel':''}" onclick="selectCAD(${i})">
        <td>#L${i+1}</td><td>(${c.meas.cx|0}, ${c.meas.cy|0})</td>
        <td>${c.meas.areaMM.toFixed(1)}</td><td>${c.meas.longDiam.toFixed(1)}</td>
        <td>${c.conf}%</td></tr>`).join('');
}
function selectCAD(i){
    cadList.forEach((c,j)=>c.selected=i===j);
    pushUndo(); mask=cadList[i].mask.slice();
    renderCADTable();render();measure();
}

// ---------------- 定量测量 ----------------
function computeMeasure(m) {
    if(!m) return null;
    const pts=[];let sx=0,sy=0,sum=0,sum2=0,peri=0;
    let x0=W,y0=H,x1=0,y1=0;
    for(let y=0;y<H;y++)for(let x=0;x<W;x++){
        const i=y*W+x;if(!m[i])continue;
        pts.push([x,y]);sx+=x;sy+=y;
        const v=S.gray[i];sum+=v;sum2+=v*v;
        if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y;
        if(x>0&&x<W-1&&y>0&&y<H-1&&(!m[i-1]||!m[i+1]||!m[i-W]||!m[i+W]))peri++;
    }
    const n=pts.length; if(n<10) return null;
    const mm=S.mmPerPx, mean=sum/n;
    const std=Math.sqrt(Math.max(0,sum2/n-mean*mean));
    // 凸包求最大长径（RECIST）
    const hull=convexHull(pts);
    let maxD=0,a=hull[0],b=hull[0];
    for(let i=0;i<hull.length;i++)for(let j=i+1;j<hull.length;j++){
        const d=(hull[i][0]-hull[j][0])**2+(hull[i][1]-hull[j][1])**2;
        if(d>maxD){maxD=d;a=hull[i];b=hull[j];}
    }
    const areaMM=n*mm*mm;
    return {
        n, areaMM, longDiam:Math.sqrt(maxD)*mm, diamLine:[a,b],
        eqDiam:2*Math.sqrt(areaMM/Math.PI),
        periMM:peri*mm, circularity:Math.min(1,4*Math.PI*n/(peri*peri||1)),
        mean, std, cx:sx/n, cy:sy/n, bbox:[x0,y0,x1,y1]
    };
}
function convexHull(pts){
    const p=pts.slice().sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
    const cross=(o,a,b)=>(a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0]);
    const lower=[],upper=[];
    for(const pt of p){while(lower.length>=2&&cross(lower[lower.length-2],lower[lower.length-1],pt)<=0)lower.pop();lower.push(pt);}
    for(let i=p.length-1;i>=0;i--){const pt=p[i];
        while(upper.length>=2&&cross(upper[upper.length-2],upper[upper.length-1],pt)<=0)upper.pop();upper.push(pt);}
    lower.pop();upper.pop();return lower.concat(upper);
}

function measure() {
    const m=computeMeasure(mask);
    const has=!!m;
    document.getElementById('mEmpty').style.display=has?'none':'block';
    document.getElementById('mGrid').style.display=has?'grid':'none';
    document.getElementById('dicePanel').style.display=(has&&S.gold)?'block':'none';
    if(!has){renderHist();return;}
    document.getElementById('mArea').textContent=m.areaMM.toFixed(1);
    document.getElementById('mAreaPx').textContent=m.n+' px';
    document.getElementById('mDiam').textContent=m.longDiam.toFixed(1);
    document.getElementById('mEq').textContent='等效径 '+m.eqDiam.toFixed(1)+' mm';
    document.getElementById('mPeri').textContent=m.periMM.toFixed(1);
    document.getElementById('mCirc').textContent='圆度 '+m.circularity.toFixed(2);
    document.getElementById('mGray').textContent=m.mean.toFixed(1)+' ± '+m.std.toFixed(1);
    document.getElementById('mCenter').textContent=`(${m.cx|0}, ${m.cy|0}) · [${m.bbox[2]-m.bbox[0]}×${m.bbox[3]-m.bbox[1]}]`;
    // 周围对比度
    const ring=dilate(dilate(mask));
    let rSum=0,rN=0;
    for(let i=0;i<W*H;i++)if(!mask[i]&&ring[i]){rSum+=S.gray[i];rN++;}
    document.getElementById('mContrast').textContent=
        (rN?(m.mean-rSum/rN):0).toFixed(1);
    // Dice vs 金标准（导入影像无金标准时跳过）
    if (S.gold) {
    let inter=0,mN=0,gN=0;
    for(let i=0;i<W*H;i++){
        if(mask[i])mN++;if(S.gold[i])gN++;
        if(mask[i]&&S.gold[i])inter++;
    }
    const dice=2*inter/(mN+gN||1), iou=inter/(mN+gN-inter||1);
    document.getElementById('diceVal').textContent=(dice*100).toFixed(1)+'%';
    document.getElementById('iouVal').textContent=(iou*100).toFixed(1)+'%';
    document.getElementById('recallVal').textContent=(inter/(gN||1)*100).toFixed(1)+'%';
    document.getElementById('precVal').textContent=(inter/(mN||1)*100).toFixed(1)+'%';
    }
    if(S.rgb) analyzeABCD();
    renderHist();
}

// ---------------- 直方图 ----------------
let histChart=null;
function renderHist() {
    if(!histChart) histChart=echarts.init(document.getElementById('histBox'));
    const bins=new Array(32).fill(0),lesionBins=new Array(32).fill(0);
    for(let i=0;i<W*H;i++){
        const b=Math.min(31,S.gray[i]/8|0);
        bins[b]++;if(mask&&mask[i])lesionBins[b]++;
    }
    histChart.setOption({
        grid:{top:10,bottom:22,left:40,right:8},
        tooltip:{},
        xAxis:{type:'category',data:bins.map((_,i)=>i*8),
            axisLabel:{color:'#6b8299',fontSize:9,interval:7},
            axisLine:{lineStyle:{color:'#dfeaf4'}}},
        yAxis:{type:'value',axisLabel:{color:'#6b8299',fontSize:9},
            splitLine:{lineStyle:{color:'#eef4fa'}}},
        series:[
            {type:'bar',data:bins,itemStyle:{color:'rgba(58,124,168,0.3)'},barGap:'-100%'},
            {type:'bar',data:lesionBins,itemStyle:{color:'#00b4d8'}}]
    },{notMerge:true});
}

// ---------------- 交互事件 ----------------
function canvasPos(e){
    const r=cv.getBoundingClientRect();
    return [Math.round((e.clientX-r.left)/r.width*W),Math.round((e.clientY-r.top)/r.height*H)];
}
let painting=false;
cv.addEventListener('mousedown',e=>{
    const [x,y]=canvasPos(e);
    if(x<0||y<0||x>=W||y>=H)return;
    if(splitPct>=0){ splitDrag=true; return; }
    if(tool==='seed'){
        pushUndo(); mask=regionGrow(x,y); afterSeg(`种子 (${x},${y})`);
    }else{pushUndo(); painting=true;paintAt(x,y);}
});
let splitDrag=false;
cv.addEventListener('mousemove',e=>{
    const [x,y]=canvasPos(e);
    hoverInfo={x,y};updateHover();
    if(splitDrag){splitPct=Math.max(0,Math.min(100,x/W*100));
        document.getElementById('splitRange').value=splitPct;render();return;}
    if(painting)paintAt(x,y);
});
window.addEventListener('mouseup',()=>{
    if(painting){painting=false;afterSeg('画笔精修');}
    splitDrag=false;
});
function paintAt(x,y){
    const val=tool==='erase'?0:1;
    for(let dy=-brushR;dy<=brushR;dy++)for(let dx=-brushR;dx<=brushR;dx++){
        if(dx*dx+dy*dy>brushR*brushR)continue;
        const nx=x+dx,ny=y+dy;
        if(nx>=0&&ny>=0&&nx<W&&ny<H)mask[ny*W+nx]=val;
    }
    render();
}
function updateHover(){
    const {x,y}=hoverInfo;
    if(x<0||x>=W||y<0||y>=H)return;
    document.getElementById('hoverInfo').textContent=
        `坐标 (${x}, ${y}) | 灰度 ${S?S.gray[y*W+x].toFixed(0):'--'} | ${tool==='seed'?'种子模式':tool==='brush'?'画笔':'橡皮'}`;
}
function pushUndo(){undoStack.push(mask.slice());if(undoStack.length>20)undoStack.shift();}
function undo(){if(!undoStack.length)return toast('没有可撤销步骤');
    mask=undoStack.pop();render();measure();}
function clearMask(){pushUndo();mask=new Uint8Array(W*H);cadList=[];
    renderCADTable();render();measure();}
function afterSeg(msg){render();measure();
    document.getElementById('segStatus').textContent=msg;}

// ---------------- 工具栏绑定 ----------------
function setTool(t){tool=t;
    document.querySelectorAll('.tool-tab').forEach(b=>
        b.classList.toggle('active',b.dataset.tool===t));
    cv.style.cursor=t==='seed'?'crosshair':'cell';}
function bindRanges(){
    const bind=(id,valId,fn)=>{const el=document.getElementById(id);
        el.addEventListener('input',()=>{document.getElementById(valId).textContent=el.value;fn(+el.value);});};
    bind('wwRange','wwVal',v=>{ww=v;render();});
    bind('wlRange','wlVal',v=>{wl=v;render();});
    bind('tolRange','tolVal',v=>tolerance=v);
    bind('brushRange','brushVal',v=>brushR=v);
    bind('otsuRange','otsuVal',v=>otsuT=v);
    bind('opacityRange','opacityVal',v=>{maskOpacity=v/100;render();});
    bind('cadOffsetRange','cadOffsetVal',v=>cadOffset=v);
    bind('minAreaRange','minAreaVal',v=>minArea=v);
    document.getElementById('splitRange').addEventListener('input',e=>{
        splitPct=+e.target.value;render();});
}
function presetWindow(w,l){ww=w;wl=l;
    document.getElementById('wwRange').value=w;document.getElementById('wlRange').value=l;
    document.getElementById('wwVal').textContent=w;document.getElementById('wlVal').textContent=l;render();}
function toggleLayer(k,el){layer[k]=el.checked;render();}

// ---------------- RECIST 随访 ----------------
function saveFollowup(){
    const m=computeMeasure(mask);if(!m)return toast('请先分割病灶');
    const key='medseg_fu_'+S.id;
    const recs=JSON.parse(localStorage.getItem(key)||'[]');
    recs.push({time:new Date().toLocaleString('zh-CN',{hour12:false}),
        diam:+m.longDiam.toFixed(2),area:+m.areaMM.toFixed(2)});
    localStorage.setItem(key,JSON.stringify(recs));
    renderFollowups();toast('已记录随访测量');
}
function renderFollowups(){
    const key='medseg_fu_'+S.id;
    const recs=JSON.parse(localStorage.getItem(key)||'[]');
    const box=document.getElementById('fuList');
    document.getElementById('fuEmpty').style.display=recs.length?'none':'block';
    if(!recs.length){box.innerHTML='';document.getElementById('fuResult').textContent='--';return;}
    const base=recs[0],last=recs[recs.length-1];
    const change=(last.diam-base.diam)/base.diam*100;
    let grade,cls;
    if(last.area===0){grade='CR 完全缓解';cls='ok';}
    else if(change<=-30){grade='PR 部分缓解';cls='ok';}
    else if(change>=20){grade='PD 疾病进展';cls='bad';}
    else{grade='SD 疾病稳定';cls='mid';}
    const el=document.getElementById('fuResult');
    el.textContent=`${grade}（长径较基线 ${change>=0?'+':''}${change.toFixed(1)}%）`;
    el.className='fu-result '+cls;
    box.innerHTML=recs.map((r,i)=>`<div class="fu-row">
        <span>#${i+1} ${r.time}</span><span>${r.diam} mm · ${r.area} mm²</span></div>`).join('');
}
function clearFollowups(){
    if(!confirm('清空本样本的随访记录？'))return;
    localStorage.removeItem('medseg_fu_'+S.id);renderFollowups();
}

// ---------------- ABCD（皮肤镜） ----------------
function analyzeABCD(){
    const m=computeMeasure(mask);if(!m)return;
    // 不对称（双轴镜像）
    const pts=[];for(let i=0;i<W*H;i++)if(mask[i])pts.push([i%W,(i/W)|0]);
    const set=new Set(pts.map(([x,y])=>y*W+x));
    const asym=f=>{let d=0;pts.forEach(([x,y])=>{
        const[mx,my]=f(x,y);if(!set.has(Math.round(my)*W+Math.round(mx)))d++;});return d/pts.length;};
    const a=(asym((x,y)=>[2*m.cx-x,y])+asym((x,y)=>[x,2*m.cy-y]))/2;
    const b=1/m.circularity;             // 紧凑度
    // 颜色计数
    let colors=new Set();
    if(S.rgb){const cnt=[0,0,0,0];let tot=0;
        for(let i=0;i<W*H;i++){if(!mask[i])continue;tot++;
            const r=S.rgb[i*3],g=S.rgb[i*3+1],bl=S.rgb[i*3+2];
            const lum=0.299*r+0.587*g+0.114*bl;
            if(lum<60)cnt[0]++;else if(r>140&&g>100)cnt[1]++;
            else if(r>90)cnt[2]++;else cnt[3]++;}
        colors=cnt.map((c,i)=>({c,i})).filter(x=>x.c/tot>0.05);}
    document.getElementById('abcdA').textContent=(a*100).toFixed(1)+'%';
    document.getElementById('abcdB').textContent=b.toFixed(2);
    document.getElementById('abcdC').textContent=(S.rgb?colors.length:'--')+' 种';
    document.getElementById('abcdD').textContent=m.longDiam.toFixed(1)+' mm';
}

// ---------------- 报告导出 ----------------
function exportReport(){
    const m=computeMeasure(mask);
    const name=document.getElementById('patName').value||'（未填写）';
    const pid=document.getElementById('patId').value||'（未填写）';
    let diceTxt='--';
    if(m){let inter=0,mN=0,gN=0;
        for(let i=0;i<W*H;i++){if(mask[i])mN++;if(S.gold[i])gN++;if(mask[i]&&S.gold[i])inter++;}
        diceTxt=(2*inter/(mN+gN||1)*100).toFixed(1)+'%';}
    const fu=JSON.parse(localStorage.getItem('medseg_fu_'+S.id)||'[]');
    const txt=[
'════════════════════════════════════════',
'        MedSeg Studio · 影像分析报告',
'════════════════════════════════════════',
`患者姓名: ${name}    病历号: ${pid}`,
`检查项目: ${S.name}（${S.modality}）`,
`报告时间: ${new Date().toLocaleString('zh-CN',{hour12:false})}`,
`空间标定: ${S.mmPerPx} mm/px（合成教学样本）`,
'',
'【影像所见】',
S.finding,
'',
'【病灶定量测量】',
m?`  面积: ${m.areaMM.toFixed(1)} mm² (${m.n} px)
  最大长径(RECIST): ${m.longDiam.toFixed(1)} mm
  等效直径: ${m.eqDiam.toFixed(1)} mm
  边界周长: ${m.periMM.toFixed(1)} mm  圆度: ${m.circularity.toFixed(2)}
  灰度均值: ${m.mean.toFixed(1)} ± ${m.std.toFixed(1)}
  质心: (${m.cx|0}, ${m.cy|0})  包围盒: [${m.bbox.join(', ')}]`:'  未分割',
'',
'【算法验证】',
`  Dice 相似系数: ${diceTxt}（相对合成金标准）`,
'',
'【CAD 候选病灶】',
...(cadList.length?cadList.map((c,i)=>
`  #L${i+1}  中心(${c.meas.cx|0},${c.meas.cy|0})  面积${c.meas.areaMM.toFixed(1)}mm²  长径${c.meas.longDiam.toFixed(1)}mm  置信度${c.conf}%`):['  未执行']),
'',
'【RECIST 随访】',
...(fu.length?fu.map((r,i)=>`  #${i+1} ${r.time}  长径${r.diam}mm  面积${r.area}mm²`):['  无记录']),
`  当前分级: ${document.getElementById('fuResult').textContent}`,
'',
'【声明】本报告由教学系统生成，影像为程序合成样本，',
'不构成真实临床诊断依据。',
'════════════════════════════════════════'].join('\n');
    const a=document.createElement('a');
    a.href=URL.createObjectURL(new Blob(['﻿'+txt],{type:'text/plain;charset=utf-8'}));
    a.download=`MedSeg报告_${S.name}_${Date.now()}.txt`;a.click();
    toast('报告已导出');
}
function downloadImage(type){
    if(type==='overlay'){
        const a=document.createElement('a');a.href=cv.toDataURL('image/png');
        a.download='MedSeg_叠加图.png';a.click();
    }else{
        const c=document.createElement('canvas');c.width=W;c.height=H;
        const cx2=c.getContext('2d');const img=cx2.createImageData(W,H);
        for(let i=0;i<W*H;i++){const v=mask[i]?255:0;
            img.data[i*4]=v;img.data[i*4+1]=v;img.data[i*4+2]=v;img.data[i*4+3]=255;}
        cx2.putImageData(img,0,0);
        const a=document.createElement('a');a.href=c.toDataURL('image/png');
        a.download='MedSeg_二值掩膜.png';a.click();
    }
    toast('已下载');
}
function toast(msg){
    const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');
    setTimeout(()=>t.classList.remove('show'),2500);
}

// ---------------- 启动 ----------------
bindRanges();
loadSample('mri');
