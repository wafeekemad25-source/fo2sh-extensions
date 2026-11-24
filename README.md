# Fo2sh Extensions

إضافات Chrome (وEdge وBrave وArc) لتنزيل الصور والفيديوهات بأعلى جودة.

| الإضافة | بتعمل إيه |
|---|---|
| `fo2sh-pinterest-downloader` | فيديو MP4، صورة أصلية، صوت WAV، فريم PNG، كل الكاروسيل |
| `fo2sh-reddit-downloader` | فيديو بالصوت، GIF، صور، صوت M4A، كل الـ Gallery |
| `fo2sh-instagram-downloader` | صور وفيديوهات وReels وStories بأعلى جودة، صوت، فريم، كل الكاروسيل |
| `fo2sh-youtube-downloader` | قائمة جودات بالأحجام، MP3 / WAV / M4A (محتاجة `install.command` مرة واحدة) |

## أول مرة على أي ماك

1. افتح Terminal، واكتب `bash` ومسافة، واسحب ملف `update.command` جوه الـ Terminal، ودوس Enter.
   هينزّل كل الإضافات في فولدر `Documents`.
2. افتح `chrome://extensions`، وشغّل **Developer mode**، ودوس **Load unpacked**، واختار فولدر كل إضافة من `Documents`.
   - YouTube: اختار فولدر `fo2sh-youtube-downloader/extension`، وشغّل `fo2sh-youtube-downloader/install.command` مرة واحدة بنفس طريقة `bash`.

## التحديث

لما شباك أي إضافة يقولك **فيه نسخة جديدة**:

1. شغّل `update.command` بنفس الطريقة (`bash` ومسافة، واسحب الملف، وEnter).
2. في `chrome://extensions` دوس **Reload** على الإضافات.

نصيحة: احفظ الأمر ده في Notes، وتقدر تشغّل التحديث بيه على طول من غير الملف:

```
curl -fsSL https://raw.githubusercontent.com/wafeekemad25-source/fo2sh-extensions/main/update.command | bash
```

التحديث بينزّل بس الملفات اللي اتغيرت، فبيخلص في ثواني. أول مرة بس بتاخد وقت أطول (حوالي 32MB).

الملفات اللي بتنزل بتتحفظ في تنزيلات Chrome، جوه فولدر لكل موقع: `Downloads/Pinterest`، `Downloads/Reddit`، `Downloads/Instagram`، `Downloads/YouTube`.
