import {tryAppendQueryString, getBidIdParameter, escapeUnsafeChars} from '../src/utils.js';
import {registerBidder} from '../src/adapters/bidderFactory.js';
import {BANNER, NATIVE} from '../src/mediaTypes.js';
import {config} from '../src/config.js';
import { convertOrtbRequestToProprietaryNative } from '../src/native.js';

const ADG_BIDDER_CODE = 'adgeneration';

export const spec = {
  code: ADG_BIDDER_CODE,
  aliases: ['adg'], // short code
  supportedMediaTypes: [BANNER, NATIVE],
  /**
   * Determines whether or not the given bid request is valid.
   *
   * @param {BidRequest} bid The bid params to validate.
   * @return boolean True if this is a valid bid, and false otherwise.
   */
  isBidRequestValid: function (bid) {
    return !!(bid.params.id);
  },
  /**
   * Make a server request from the list of BidRequests.
   *
   * @param {validBidRequests[]} - an array of bids
   * @return ServerRequest Info describing the request to the server.
   */
  buildRequests: function (validBidRequests, bidderRequest) {
    // convert Native ORTB definition to old-style prebid native definition
    validBidRequests = convertOrtbRequestToProprietaryNative(validBidRequests);
    const ADGENE_PREBID_VERSION = '1.5.0';
    let serverRequests = [];
    for (let i = 0, len = validBidRequests.length; i < len; i++) {
      const validReq = validBidRequests[i];
      const DEBUG_URL = 'https://api-test.scaleout.jp/adsv/v1';
      const URL = 'https://d.socdm.com/adsv/v1';
      const url = validReq.params.debug ? DEBUG_URL : URL;
      const criteoId = getCriteoId(validReq);
      const id5id = getId5Id(validReq);
      const id5LinkType = getId5LinkType(validReq);
      let data = ``;
      data = tryAppendQueryString(data, 'posall', 'SSPLOC');
      const id = getBidIdParameter('id', validReq.params);
      data = tryAppendQueryString(data, 'id', id);
      data = tryAppendQueryString(data, 'sdktype', '0');
      data = tryAppendQueryString(data, 'hb', 'true');
      data = tryAppendQueryString(data, 't', 'json3');
      data = tryAppendQueryString(data, 'transactionid', validReq.transactionId);
      data = tryAppendQueryString(data, 'sizes', getSizes(validReq));
      data = tryAppendQueryString(data, 'currency', getCurrencyType());
      data = tryAppendQueryString(data, 'pbver', '$prebid.version$');
      data = tryAppendQueryString(data, 'sdkname', 'prebidjs');
      data = tryAppendQueryString(data, 'adapterver', ADGENE_PREBID_VERSION);
      data = tryAppendQueryString(data, 'adgext_criteo_id', criteoId);
      data = tryAppendQueryString(data, 'adgext_id5_id', id5id);
      data = tryAppendQueryString(data, 'adgext_id5_id_link_type', id5LinkType);
      // native以外にvideo等の対応が入った場合は要修正
      if (!validReq.mediaTypes || !validReq.mediaTypes.native) {
        data = tryAppendQueryString(data, 'imark', '1');
      }

      data = tryAppendQueryString(data, 'tp', bidderRequest.refererInfo.page);
      if (isIos()) {
        const hyperId = getHyperId(validReq);
        if (hyperId != null) {
          data = tryAppendQueryString(data, 'hyper_id', hyperId);
        }
      }
      // remove the trailing "&"
      if (data.lastIndexOf('&') === data.length - 1) {
        data = data.substring(0, data.length - 1);
      }
      serverRequests.push({
        method: 'GET',
        url: url,
        data: data,
        bidRequest: validBidRequests[i]
      });
    }
    return serverRequests;
  },
  /**
   * Unpack the response from the server into a list of bids.
   *
   * @param {ServerResponse} serverResponse A successful response from the server.
   * @param {BidRequest} bidRequests
   * @return {Bid[]} An array of bids which were nested inside the server.
   */
  interpretResponse: function (serverResponse, bidRequests) {
    const body = serverResponse.body;
    if (!body.results || body.results.length < 1) {
      return [];
    }
    const bidRequest = bidRequests.bidRequest;
    const bidResponse = {
      requestId: bidRequest.bidId,
      cpm: body.cpm || 0,
      width: body.w ? body.w : 1,
      height: body.h ? body.h : 1,
      creativeId: body.creativeid || '',
      dealId: body.dealid || '',
      currency: getCurrencyType(),
      netRevenue: true,
      ttl: body.ttl || 10,
    };
    if (body.adomain && Array.isArray(body.adomain) && body.adomain.length) {
      bidResponse.meta = {
        advertiserDomains: body.adomain
      }
    }
    if (isNative(body)) {
      bidResponse.native = createNativeAd(body);
      bidResponse.mediaType = NATIVE;
    } else {
      // banner
      bidResponse.ad = createAd(body, bidRequest);
    }
    return [bidResponse];
  },

  /**
   * Register the user sync pixels which should be dropped after the auction.
   *
   * @param {SyncOptions} syncOptions Which user syncs are allowed?
   * @param {ServerResponse[]} serverResponses List of server's responses.
   * @return {UserSync[]} The user syncs which should be dropped.
   */
  getUserSyncs: function (syncOptions, serverResponses) {
    const syncs = [];
    return syncs;
  }
};

function createAd(body, bidRequest) {
  let ad = body.ad;
  if (body.vastxml && body.vastxml.length > 0) {
    if (isUpperBillboard(body)) {
      const marginTop = bidRequest.params.marginTop ? bidRequest.params.marginTop : '0';
      ad = `<body>${createADGBrowserMTag()}${insertVASTMethodForADGBrowserM(body.vastxml, marginTop)}</body>`;
    } else {
      ad = `<body><div id="apvad-${bidRequest.bidId}"></div>${createAPVTag()}${insertVASTMethodForAPV(bidRequest.bidId, body.vastxml)}</body>`;
    }
  }
  ad = appendChildToBody(ad, body.beacon);
  if (removeWrapper(ad)) return removeWrapper(ad);
  return ad;
}

function isUpperBillboard(body) {
  if (body.location_params && body.location_params.option && body.location_params.option.ad_type) {
    return body.location_params.option.ad_type === 'upper_billboard';
  }
  return false;
}

function isNative(body) {
  if (!body) return false;
  return body.native_ad && body.native_ad.assets.length > 0;
}

function createNativeAd(body) {
  let native = {};
  if (body.native_ad && body.native_ad.assets.length > 0) {
    const assets = body.native_ad.assets;
    for (let i = 0, len = assets.length; i < len; i++) {
      switch (assets[i].id) {
        case 1:
          native.title = assets[i].title.text;
          break;
        case 2:
          native.image = {
            url: assets[i].img.url,
            height: assets[i].img.h,
            width: assets[i].img.w,
          };
          break;
        case 3:
          native.icon = {
            url: assets[i].img.url,
            height: assets[i].img.h,
            width: assets[i].img.w,
          };
          break;
        case 4:
          native.sponsoredBy = assets[i].data.value;
          break;
        case 5:
          native.body = assets[i].data.value;
          break;
        case 6:
          native.cta = assets[i].data.value;
          break;
        case 502:
          native.privacyLink = encodeURIComponent(assets[i].data.value);
          break;
      }
    }
    native.clickUrl = body.native_ad.link.url;
    native.clickTrackers = body.native_ad.link.clicktrackers || [];
    native.impressionTrackers = body.native_ad.imptrackers || [];
    if (body.beaconurl && body.beaconurl != '') {
      native.impressionTrackers.push(body.beaconurl);
    }
  }
  return native;
}

function appendChildToBody(ad, data) {
  return ad.replace(/<\/\s?body>/, `${data}</body>`);
}

/**
 * create APVTag
 * @return {string}
 */
function createAPVTag() {
  const APVURL = 'https://cdn.apvdr.com/js/VideoAd.min.js';
  return `<script type="text/javascript" id="apv" src="${APVURL}"></script>`
}

/**
 * create ADGBrowserMTag
 * @return {string}
 */
function createADGBrowserMTag() {
  const ADGBrowserMURL = 'https://i.socdm.com/sdk/js/adg-browser-m.js';
  return `<script type="text/javascript" src="${ADGBrowserMURL}"></script>`;
}

/**
 * create APVTag & insertVast
 * @param targetId
 * @param vastXml
 * @return {string}
 */
function insertVASTMethodForAPV(targetId, vastXml) {
  let apvVideoAdParam = {
    s: targetId
  };
  return `<script type="text/javascript">(function(){ new APV.VideoAd(${escapeUnsafeChars(JSON.stringify(apvVideoAdParam))}).load('${vastXml.replace(/\r?\n/g, '')}'); })();</script>`
}

/**
 * create ADGBrowserMTag & insertVast
 * @param vastXml
 * @param marginTop
 * @return {string}
 */
function insertVASTMethodForADGBrowserM(vastXml, marginTop) {
  return `<script type="text/javascript">window.ADGBrowserM.init({vastXml: '${vastXml.replace(/\r?\n/g, '')}', marginTop: '${marginTop}'});</script>`
}

/**
 *
 * @param ad
 */
function removeWrapper(ad) {
  const bodyIndex = ad.indexOf('<body>');
  const lastBodyIndex = ad.lastIndexOf('</body>');
  if (bodyIndex === -1 || lastBodyIndex === -1) return false;
  return ad.substr(bodyIndex, lastBodyIndex).replace('<body>', '').replace('</body>', '');
}

/**
 * request
 * @param validReq request
 * @returns {?string} 300x250,320x50...
 */
function getSizes(validReq) {
  const sizes = validReq.sizes;
  if (!sizes || sizes.length < 1) return null;
  let sizesStr = '';
  for (const i in sizes) {
    const size = sizes[i];
    if (size.length !== 2) return null;
    sizesStr += `${size[0]}x${size[1]},`;
  }
  if (sizesStr || sizesStr.lastIndexOf(',') === sizesStr.length - 1) {
    sizesStr = sizesStr.substring(0, sizesStr.length - 1);
  }
  return sizesStr;
}

/**
 * @return {?string} USD or JPY
 */
function getCurrencyType() {
  if (config.getConfig('currency.adServerCurrency') && config.getConfig('currency.adServerCurrency').toUpperCase() === 'USD') return 'USD';
  return 'JPY';
}

/**
 *
 * @param validReq request
 * @return {null|string}
 */
function getCriteoId(validReq) {
  return (validReq.userId && validReq.userId.criteoId) ? validReq.userId.criteoId : null
}

function getId5Id(validReq) {
  return validId5(validReq) ? validReq.userId.id5id.uid : null
}

function getId5LinkType(validReq) {
  return validId5(validReq) ? validReq.userId.id5id.ext.linkType : null
}

function validId5(validReq) {
  return validReq.userId && validReq.userId.id5id && validReq.userId.id5id.uid && validReq.userId.id5id.ext.linkType
}

function getHyperId(validReq) {
  if (validReq.userId && validReq.userId.novatiq && validReq.userId.novatiq.snowflake.syncResponse === 1) {
    return validReq.userId.novatiq.snowflake.id;
  }
  return null;
}

function isIos() {
  return (/(ios|ipod|ipad|iphone)/i).test(window.navigator.userAgent);
}

registerBidder(spec);
