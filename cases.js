// Заглушки. Когда будут кейсы на английском, у каждого заполнить:
//   title, client, services (1-3 услуги), year, description (2-3 предложения, до 300 знаков),
//   results (до 3 цифр: value + label), frames (кадры кейса по порядку).
// Кадр: { img: 'assets/xxx.jpg' } или { video: 'assets/xxx.mp4', poster: 'assets/xxx.jpg' }
// (mp4 без звука, короткий луп). Первый кадр с img - обложка в облаке, ratio - его пропорция.
// В облаке 28 карточек (на мобилке 20), берутся первые кейсы по порядку; если кейсов меньше, они повторяются.
export const SERVICES = ['Banner creatives', 'Promo sites', 'Video', 'Motion design'];
const SIZES = [[4, 5], [1, 1], [3, 2], [4, 5], [3, 4], [16, 10], [1, 1], [2, 3]];

// картинки лежат в assets/cases (скачаны с picsum: большая сторона 1200px для кейса, 640px обложка для облака).
// Путь считаем от этого файла, а не от страницы: так он верный и в корне, и в /a/ /c/ /e/, и на хостинге
const pic = (seed, thumb = false) => new URL(`./assets/cases/${seed}${thumb ? '-t' : ''}.jpg`, import.meta.url).href;

export const CASES = Array.from({ length: 24 }, (_, i) => {
  const [w, h] = SIZES[i % SIZES.length];
  const frames = Array.from({ length: 2 + (i % 3) }, (_, f) => ({ img: pic(`mbk${i + 3}${f ? '-' + f : ''}`) }));
  return {
    title: `Case ${String(i + 1).padStart(2, '0')}`,
    client: 'Client name',
    services: [SERVICES[i % SERVICES.length], SERVICES[(i + 1) % SERVICES.length]],
    year: 2025 + (i % 2),
    description: 'Placeholder. What the client needed, the idea we came up with and what we shipped. Two or three sentences, up to 300 characters.',
    results: [{ value: '+00%', label: 'CTR' }, { value: '0.0M', label: 'Reach' }, { value: '00', label: 'Assets' }],
    ratio: w / h,
    img: frames[0].img,
    thumb: pic(`mbk${i + 3}`, true),   // обложка для облака: в 4 раза легче полного кадра
    frames,
  };
});

// услуга для подписи в курсоре
CASES.forEach(c => { c.tag = c.services[0]; });
