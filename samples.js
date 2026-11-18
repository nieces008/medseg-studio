/* ============================================================
 * MedSeg Studio · 合成教学影像生成器
 * 生成 512×512 教学用合成影像 + 病灶金标准掩膜。
 * 注意：均为程序合成的教学数据，非真实患者影像。
 * ============================================================ */

// 种子化伪随机（可复现）
function makeRng(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const SAMPLE_SIZE = 512;

function blankSample(meta) {
    const n = SAMPLE_SIZE * SAMPLE_SIZE;
    return Object.assign({
        w: SAMPLE_SIZE, h: SAMPLE_SIZE,
        gray: new Float32Array(n),       // 灰阶 0-255
        rgb: null,                        // 皮肤镜用 RGB
        gold: new Uint8Array(n),          // 金标准病灶掩膜
        seed: [SAMPLE_SIZE>>1, SAMPLE_SIZE>>1]
    }, meta);
}

// 平滑值噪声
function noiseField(rng, w, h, grid) {
    const gw = Math.ceil(w/grid)+2, gh = Math.ceil(h/grid)+2;
    const g = new Float32Array(gw*gh);
    for (let i = 0; i < g.length; i++) g[i] = rng();
    return (x,y) => {
        const gx = x/grid, gy = y/grid;
        const x0 = gx|0, y0 = gy|0, fx = gx-x0, fy = gy-y0;
        const sx = fx*fx*(3-2*fx), sy = fy*fy*(3-2*fy);
        const a = g[y0*gw+x0], b = g[y0*gw+x0+1], c = g[(y0+1)*gw+x0], d = g[(y0+1)*gw+x0+1];
        return a+(b-a)*sx+(c-a)*sy+(a-b-c+d)*sx*sy;
    };
}

function ellipse(x,y,cx,cy,rx,ry) {
    const dx=(x-cx)/rx, dy=(y-cy)/ry;
    return dx*dx+dy*dy;
}

// ---------- 样本1：脑部增强 MRI（高信号病灶） ----------
function genBrainMRI() {
    const s = blankSample({
        id:'mri', name:'脑部增强 MRI', desc:'T1c 轴位 · 右侧顶枕叶强化灶',
        mmPerPx:0.45, polarity:'bright', modality:'MRI',
        defaultWW:255, defaultWL:128,
        finding:'右侧顶枕叶见类圆形明显均匀强化高信号灶，边界较清，周围轻度水肿。'
    });
    const rng = makeRng(20240001);
    const nf = noiseField(rng, 512, 512, 26);
    const nf2 = noiseField(rng, 512, 512, 8);
    const LX=340, LY=300, LR=22;                 // 病灶中心与半径
    s.seed = [LX, LY];
    for (let y=0;y<512;y++) for (let x=0;x<512;x++) {
        const i=y*512+x;
        const brain = ellipse(x,y,256,262,178,208);
        let v = 0;
        if (brain < 1) {
            v = 108 + nf(x,y)*34 + nf2(x,y)*14 - 20;
            // 脑室（中央暗区）
            if (ellipse(x,y,232,240,16,34)<1 || ellipse(x,y,282,240,16,34)<1) v = 52 + nf2(x,y)*10;
            // 水肿环
            const dl = Math.hypot(x-LX,y-LY);
            if (dl < LR+13 && dl >= LR) v = 82 + nf2(x,y)*8;
        } else if (brain < 1.22) {                // 颅骨亮环
            v = 196 + nf2(x,y)*24;
        }
        // 病灶：半径微扰动的亮圆
        const ang = Math.atan2(y-LY,x-LX);
        const r = LR + Math.sin(ang*5)*1.6 + Math.cos(ang*3)*1.2;
        const dl = Math.hypot(x-LX,y-LY);
        if (dl < r) { v = 222 + nf2(x,y)*16; s.gold[i]=1; }
        s.gray[i] = Math.max(0, Math.min(255, v));
    }
    return s;
}

// ---------- 样本2：胸部 CT 肺结节 ----------
function genChestCT() {
    const s = blankSample({
        id:'ct', name:'胸部 CT 肺结节', desc:'肺窗 · 左肺上叶孤立性结节',
        mmPerPx:0.68, polarity:'bright', modality:'CT',
        defaultWW:220, defaultWL:110,
        finding:'左肺上叶见孤立性类圆形软组织密度结节，边缘尚光整，建议随访。'
    });
    const rng = makeRng(20240002);
    const nf = noiseField(rng,512,512,20);
    const nf2 = noiseField(rng,512,512,6);
    const LX=176, LY=236, LR=14;
    s.seed=[LX,LY];
    for (let y=0;y<512;y++) for (let x=0;x<512;x++) {
        const i=y*512+x;
        let v = 0;
        const body = ellipse(x,y,256,270,220,190);
        if (body < 1) {
            v = 168 + nf2(x,y)*18;                              // 胸壁软组织
            const lungL = ellipse(x,y,168,250,86,128);
            const lungR = ellipse(x,y,346,250,86,128);
            if (lungL<1 || lungR<1) {
                v = 34 + nf(x,y)*20 + nf2(x,y)*10;              // 肺实质
                // 血管纹理（条状亮影）
                if (Math.abs(Math.sin(x*0.08+y*0.05)) > 0.985) v += 60;
            }
            if (ellipse(x,y,256,250,44,110)<1) v = 142 + nf2(x,y)*14;  // 纵隔
            if (ellipse(x,y,256,380,26,22)<1) v = 210;            // 脊柱
        }
        const ang = Math.atan2(y-LY,x-LX);
        const r = LR + Math.sin(ang*4)*1.1;
        if (Math.hypot(x-LX,y-LY) < r) { v = 208 + nf2(x,y)*12; s.gold[i]=1; }
        s.gray[i] = Math.max(0, Math.min(255, v));
    }
    return s;
}

// ---------- 样本3：皮肤镜色素病灶（RGB + 暗色病灶） ----------
function genDermoscopy() {
    const s = blankSample({
        id:'derm', name:'皮肤镜色素性病灶', desc:'偏振光 · 不规则色素斑',
        mmPerPx:0.05, polarity:'dark', modality:'皮肤镜',
        defaultWW:255, defaultWL:128,
        finding:'皮肤镜下见不对称色素性病灶，颜色不均，边缘部分呈锯齿状。'
    });
    const rng = makeRng(20240003);
    const nf = noiseField(rng,512,512,40);
    const nf2 = noiseField(rng,512,512,10);
    const LX=256, LY=256, LR=86;
    s.seed=[LX,LY];
    s.rgb = new Uint8ClampedArray(512*512*3);
    for (let y=0;y<512;y++) for (let x=0;x<512;x++) {
        const i=y*512+x;
        const base = 12 + nf(x,y)*22;
        let r = 208-base, g = 168-base, b = 134-base;           // 皮肤底色
        const ang = Math.atan2(y-LY,x-LX);
        // 明显不对称 + 锯齿边缘
        const rr = LR*(1 + 0.24*Math.sin(ang*3+1.2) + 0.13*Math.cos(ang*7) + 0.06*Math.sin(ang*13));
        const dl = Math.hypot((x-LX)*1.15, y-LY);
        if (dl < rr) {
            const t = nf2(x,y);
            if (dl < rr*0.45 && t > 0.55) { r=42; g=28; b=22; }       // 中央近黑区
            else if (t > 0.62) { r=96; g=60; b=40; }                  // 深棕
            else if (t < 0.3)  { r=140; g=96; b=64; }                 // 浅棕
            else { r=76; g=48; b=34; }
            if (Math.sin(x*0.35)*Math.cos(y*0.3) > 0.86) { r=50;g=32;b=26; }  // 色素网
            s.gold[i]=1;
        }
        s.rgb[i*3]=r; s.rgb[i*3+1]=g; s.rgb[i*3+2]=b;
        s.gray[i] = 0.299*r+0.587*g+0.114*b;
    }
    return s;
}

// 缓存生成
const _sampleCache = {};
function getSample(id) {
    if (!_sampleCache[id]) {
        _sampleCache[id] = id==='mri' ? genBrainMRI() : id==='ct' ? genChestCT() : genDermoscopy();
    }
    return _sampleCache[id];
}
