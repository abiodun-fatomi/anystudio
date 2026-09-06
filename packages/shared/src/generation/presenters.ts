/**
 * Presenters — the people who can front a "filmed by a customer" ad.
 *
 * A stock presenter is a HeyGen studio avatar in everyday clothes (no
 * blazers: this is meant to look like a customer, not a newsreader). The
 * seller can also front it themselves from one photo, which is not in this
 * list because it is theirs.
 *
 * Preview images are served by HeyGen's CDN; the ids are the avatar look
 * ids HeyGen's API takes. Chosen by look, on purpose without any claim
 * about who the person is — the seller picks the face that fits.
 */
export interface Presenter {
  key: string;
  name: string;
  /** How they read on camera, for the picker. */
  look: string;
  gender: 'female' | 'male';
  previewUrl: string;
  /** The vendor's id for the look. */
  providerAvatarId: string;
  providerKey: 'heygen';
}

const cdn = (hash: string) => `https://files2.heygen.ai/avatar/v3/${hash}/preview_target.webp`;

export const PRESENTERS: readonly Presenter[] = [
  {
    key: 'daphne',
    name: 'Daphne',
    look: 'white t-shirt, bright',
    gender: 'female',
    previewUrl: cdn('338647658cf84f79b816750ebf278336_63150'),
    providerAvatarId: 'Daphne_public_4',
    providerKey: 'heygen',
  },
  {
    key: 'bryce',
    name: 'Bryce',
    look: 'black t-shirt, easy-going',
    gender: 'male',
    previewUrl: cdn('a159e97bd1074405884694913633ea7f_63060'),
    providerAvatarId: 'Bryce_public_5',
    providerKey: 'heygen',
  },
  {
    key: 'diora',
    name: 'Diora',
    look: 'white t-shirt, warm',
    gender: 'female',
    previewUrl: cdn('36f36c2e87c24d6390dc7d594925f3cb_62990'),
    providerAvatarId: 'Diora_public_4',
    providerKey: 'heygen',
  },
  {
    key: 'emery',
    name: 'Emery',
    look: 'white t-shirt, upbeat',
    gender: 'female',
    previewUrl: cdn('796d0a61e8a3490abd5953e5319604d9_62720'),
    providerAvatarId: 'Emery_public_3',
    providerKey: 'heygen',
  },
  {
    key: 'minho',
    name: 'Minho',
    look: 'white t-shirt, calm',
    gender: 'male',
    previewUrl: cdn('65edb3cc9c674d24bb13626ec4badf9f_62230'),
    providerAvatarId: 'Minho_public_4',
    providerKey: 'heygen',
  },
  {
    key: 'aditya',
    name: 'Aditya',
    look: 'blue t-shirt, friendly',
    gender: 'male',
    previewUrl: cdn('6ff8854f65b947718a29941f6d24a4d2_62160'),
    providerAvatarId: 'Aditya_public_2',
    providerKey: 'heygen',
  },
  {
    key: 'nadim',
    name: 'Nadim',
    look: 'puffer vest, streetwise',
    gender: 'male',
    previewUrl: cdn('33551063c61345f1a49a5fef45acd965_62120'),
    providerAvatarId: 'Nadim_public_3',
    providerKey: 'heygen',
  },
  {
    key: 'freja',
    name: 'Freja',
    look: 'white polo, relaxed',
    gender: 'female',
    previewUrl: cdn('b1f5b0234ed945c0b85b12ee2e5398f7_62490'),
    providerAvatarId: 'Freja_public_5',
    providerKey: 'heygen',
  },
  {
    key: 'iker',
    name: 'Iker',
    look: 'knit sweater, thoughtful',
    gender: 'male',
    previewUrl: cdn('304c9a93f4a241e78b0b660a9333429a_61730'),
    providerAvatarId: 'Iker_public_5',
    providerKey: 'heygen',
  },
];

export const presenter = (key: string | undefined): Presenter | undefined => PRESENTERS.find((p) => p.key === key);

/** A presenter adds a talking segment on top of the shots; the ad's price code gains a suffix. */
export const PRESENTER_COST_SUFFIX = '_presenter';
export const presenterCostCode = (adCostCode: string): string => `${adCostCode}${PRESENTER_COST_SUFFIX}`;
/** How many words the presenter says for a segment of this many seconds — a conversational 2.4 words/s. */
export const presenterWords = (seconds: number): number => Math.round(seconds * 2.4);
