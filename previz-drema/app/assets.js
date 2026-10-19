// GLB-модели персонажей (Higgsfield image_to_3d: текстура + авториг, A-pose) и озвучка реплик (Higgsfield seed_audio).
// Если страница задаёт window.PREVIZ_LOCAL_ASSETS, файлы берутся рядом со страницей (assets/models, assets/audio),
// иначе - с CDN Higgsfield.
const CDN = 'https://d8j0ntlcm91z4.cloudfront.net/user_36mUQno3gT2YeX3Ugy1pUi4O5Zi/';
const LOCAL = typeof window !== 'undefined' && window.PREVIZ_LOCAL_ASSETS;

const MODEL_FILES = {
  mother: 'hf_20261019_062252_e18b2bae-d0a0-4ee9-ad67-76d36a648b68.glb',
  grandpa: 'hf_20261019_062254_7509718e-9891-416d-ab9a-c7a81dc86acb.glb',
  ilya: 'hf_20261019_062255_891f874a-695e-44d2-a1f9-540b6f4db28d.glb',
  fedya: 'hf_20261019_062256_17eb2597-237b-4632-aa87-92528ea57b2b.glb',
  vera: 'hf_20261019_062258_ee5c1bb0-a4d6-4730-ac1d-f461c997ecef.glb',
  yerema: 'hf_20261019_062301_c6362c1a-983d-4bd1-8bab-7d85474b6d33.glb',
};

const AUDIO_FILES = {
  m1: 'hf_20261019_065621_cf2f84a4-7b19-4adf-b9f0-045b0889465b.mp3',
  m2: 'hf_20261019_065622_22870c31-f4ae-425b-a027-8424df4f0ba5.mp3',
  m3: 'hf_20261019_065449_0714ee28-f1a7-483a-8c64-5a926ffe5dd7.mp3',
  m4: 'hf_20261019_065621_7db196d2-1f4c-46c0-bac7-24df5be6fc44.mp3',
  m5: 'hf_20261019_065620_93488d3d-75c5-441a-9b7d-7c80c4355c46.mp3',
  m6: 'hf_20261019_065621_209be05f-6f47-4b16-af78-035d1edd3b00.mp3',
  m7: 'hf_20261019_065621_4860b95f-2f7e-4e3c-a0ea-87ac84893f35.mp3',
  m8: 'hf_20261019_065621_60f95e30-f861-4228-a777-14712829f58e.mp3',
  y1: 'hf_20261019_065621_637a6b91-8bfb-4237-8c2d-4d7f798bac71.mp3',
  y2: 'hf_20261019_065621_657688e2-cfd2-48d3-966f-78b25514fe68.mp3',
  y3: 'hf_20261019_065621_a5d9c370-6a94-4af9-a748-0ff9efd7aa0e.mp3',
  y4: 'hf_20261019_065621_fecf800c-98bc-40f0-97bf-722b8ee0c238.mp3',
  y5: 'hf_20261019_065449_7afb1cf8-a515-4a78-82e6-cde2da7cd3cb.mp3',
  y6: 'hf_20261019_065621_7dfd7151-11fe-4720-bbb7-30cca99f5a0e.mp3',
};

const map = (files, dir, ext) => Object.fromEntries(Object.entries(files).map(([k, f]) => [k, LOCAL ? `assets/${dir}/${k}.${ext}` : CDN + f]));

export const CHARACTER_URLS = map(MODEL_FILES, 'models', 'glb');
export const AUDIO_URLS = map(AUDIO_FILES, 'audio', 'mp3');

export const CHARACTER_HEIGHTS = {
  mother: 1.65, grandpa: 1.72, ilya: 1.4, fedya: 1.28, vera: 1.26, yerema: 1.1,
};
