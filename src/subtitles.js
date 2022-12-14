const Apify = require('apify');
const {log} = Apify.utils;
const fetch = require('node-fetch');

class SrtConvert {
    static TYPE_AUTO_GENERATED = 'auto_generated';
    static TYPE_USER_GENERATED = 'user_generated';

    constructor(srtJson, lang, type = SrtConvert.TYPE_AUTO_GENERATED) {
        this._json = srtJson;
        this.language = lang;
        this.type = type;

        this.srt = null;

        if (this.type !== SrtConvert.TYPE_AUTO_GENERATED && this.type !== SrtConvert.TYPE_USER_GENERATED) {
            throw new Error(`Unknown subtitles type ${this.type}`);
        }
    }

    convert() {
        let subtitles = '';
        let subtCounter = 1;
        const events = this._json['events'];
        for (let i = 0; i < events.length; i++) {
            const e = events[i];
            const segs = e['segs'];
            if (segs) {
                let line = '';
                segs.forEach(s => {
                    line += s['utf8'].replace(/\n/g, ' ');
                })
                if (line !== '\n') {
                    const tStart = e['tStartMs'];
                    subtitles += `${subtCounter}\n`;
                    subtitles += `${this._msToHMS(tStart)} --> ${this._msToHMS(tStart + e['dDurationMs'])}\n`;
                    subtitles += `${line}\n\n`;
                    subtCounter++;
                }
            }
        }

        this.srt = subtitles;

        return subtitles;
    }

    _msToHMS(ms) {
        let frac = String(ms % 1000);
        frac = ('000' + frac).substring(frac.length);
        let sec = Math.floor(ms / 1000);
        let hrs = Math.floor(sec / 3600);
        sec -= hrs * 3600;
        let min = Math.floor(sec / 60);
        sec -= min * 60;
        sec = ('00' + sec).substring(String(sec).length);

        if (hrs > 0) {
            min = ('00' + min).substring(String(min).length);
            return ('00' + hrs).substring(String(hrs).length) + ":" + min + ":" + sec + ',' + frac;
        } else {
            return '00:' + ('00' + min).substring(String(min).length) + ":" + sec + ',' + frac;
        }
    }

}

/**
 * This function fetches list of available subtitles from video detail page and then, depending on provided settings,
 * fetches subtitle JSONs and converts them to .srt format.
 *
 * @param page Puppeteer page.
 * @param language Preferred language. If `null` or `''`, we are instructed to fetch all available subtitles.
 * @param preferAutoGenerated If set to true, we prefer automatically generated subtitles before the user provided.
 * If set to false and only automatically generated subtitles are available, we fetch at least them.
 * @returns {Promise<*[]>} Promise representing the whole fetching and srt generating process. Promise result is
 * list of `SrtConvert` instances containing already converted .srt data. See `SrtConvert` class.
 */
async function fetchSubtitles(page, language = null, preferAutoGenerated = false) {
    log.debug(`Fetching subtitles for ${page.url()},lang:${language}...`);

    const converters = [];
    const script = await page.evaluate(() => {
        const scripts = document.body.querySelectorAll('script');
        let target = null;
        scripts.forEach(s => {
            const html = s.innerHTML;
            if (html.startsWith('var ytInitialPlayerResponse')) {
                target = html;
            }
        });
        return target;
    });

    try {
        let subtitlesJSON = JSON.parse(`{${String(script).match(/\"captionTracks\".*?(?=])/)}]}`);
        const captionTracks = subtitlesJSON['captionTracks'];
        let subtitlesToDl = [];
        if (!language) {
            for (let i = 0; i < captionTracks.length; i++) {
                const track = captionTracks[i];
                subtitlesToDl.push({
                    lang: track['languageCode'],
                    url: `${track['baseUrl']}&fmt=json3`,
                    type: track['kind'] ? SrtConvert.TYPE_AUTO_GENERATED : SrtConvert.TYPE_USER_GENERATED,
                });
            }
        } else {
            const urlCandidates = [];
            for (let i = 0; i < captionTracks.length; i++) {
                const track = captionTracks[i];
                if (language === track['languageCode']) {
                    urlCandidates.push(`${track['baseUrl']}&fmt=json3`);
                }
            }
            for (let i = 0; i < urlCandidates.length; i++) {
                const urlCandidate = urlCandidates[i];
                if (preferAutoGenerated) {
                    if (urlCandidate.includes('&kind=asr'))
                        subtitlesToDl.push({lang: language, url: urlCandidate, type: SrtConvert.TYPE_AUTO_GENERATED});
                } else {
                    if (!urlCandidate.includes('&kind=asr'))
                        subtitlesToDl.push({lang: language, url: urlCandidate, type: SrtConvert.TYPE_USER_GENERATED});
                }
            }
            if (urlCandidates.length === 0 && urlCandidates.length > 0)
                subtitlesToDl = [{lang: language, url: urlCandidates[0]}];
        }

        const fetchingUrls = [];
        const fetchingJsons = [];
        for (let i = 0; i < subtitlesToDl.length; i++) {
            const std = subtitlesToDl[i];
            const pFetch = fetch(std.url, {method: 'GET'});
            fetchingUrls.push(pFetch);
            pFetch.then(response => {
                const pJson = response.json();
                fetchingJsons.push(pJson);
                pJson.then(json => {
                    log.debug(
                        `Subtitle type for ${page.url()} lang:${std.lang}, type:${std.type}` +
                        ` fetched, converting to SRT...`
                    );
                    const conv = new SrtConvert(json, std.lang, std.type)
                    conv.convert();
                    converters.push(conv);
                }).catch(reason => {
                    log.warning(
                        `Unable to convert subtitles for ${page.url()}, ` +
                        `language:${std.lang}\nReason:${reason.toString()}`
                    )
                });
            }).catch(reason => {
                log.warning(
                    `Unable to fetch subtitles for ${page.url()}, ` +
                    `language:${std.lang}\nReason:${reason.toString()}`
                )
            });
        }
        await Promise.all(fetchingUrls)
        await Promise.all(fetchingJsons)
    } catch (e) {
        log.warning(`No subtitles found for ${page.url()}.`);
    }

    return converters;
}

async function processFetchedSubtitles(page, videoId, converters, subtitlesSettings) {
    let subtitles = null;
    if (converters) {
        subtitles = [];
        for (let i = 0; i < converters.length; i++) {
            const c = converters[i];
            let srtUrl = null;
            if (subtitlesSettings.saveToKVS) {
                const id = `subtitles_${videoId}_${c.language}_${c.type}`;
                log.debug(
                    `Saving subtitles for ${page.url()}, lang:${c.language}, ` +
                    `type:${c.type} to KeyValueStore, id=${id}`
                );
                await subtitlesSettings.kvs.setValue(id, {
                    subtitles: c.srt,
                    type: c.type,
                    language: c.language,
                });
                srtUrl = subtitlesSettings.kvs.getPublicUrl(id);
            }
            subtitles.push({
                srt: c.srt,
                srtUrl: srtUrl,
                type: c.type,
                language: c.language,
            });
        }
    }
    return subtitles;
}

exports.fetchSubtitles = fetchSubtitles;
exports.processFetchedSubtitles = processFetchedSubtitles;
