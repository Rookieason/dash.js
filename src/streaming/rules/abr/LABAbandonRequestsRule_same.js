/**
 * The copyright in this software is being made available under the BSD License,
 * included below. This software may be subject to other third party and contributor
 * rights, including patent rights, and no such rights are granted under this license.
 *
 * Copyright (c) 2013, Dash Industry Forum.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *  * Redistributions of source code must retain the above copyright notice, this
 *  list of conditions and the following disclaimer.
 *  * Redistributions in binary form must reproduce the above copyright notice,
 *  this list of conditions and the following disclaimer in the documentation and/or
 *  other materials provided with the distribution.
 *  * Neither the name of Dash Industry Forum nor the names of its
 *  contributors may be used to endorse or promote products derived from this software
 *  without specific prior written permission.
 *
 *  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS AS IS AND ANY
 *  EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 *  WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 *  IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
 *  INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
 *  NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 *  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 *  WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 *  ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 *  POSSIBILITY OF SUCH DAMAGE.
 */
import SwitchRequest from '../SwitchRequest';
import FactoryMaker from '../../../core/FactoryMaker';
import Debug from '../../../core/Debug';

const BOLA_STATE_ONE_BITRATE = 0;
const BOLA_STATE_STARTUP = 1;

const MINIMUM_BUFFER_S = 10; // BOLA should never add artificial delays if buffer is less than MINIMUM_BUFFER_S.
const MINIMUM_BUFFER_PER_BITRATE_LEVEL_S = 2;

function AbandonRequestsRule(config) {

    config = config || {};
    const ABANDON_MULTIPLIER = 1.8;
    const GRACE_TIME_THRESHOLD = 500;
    const MIN_LENGTH_TO_AVERAGE = 5;

    const context = this.context;
    const mediaPlayerModel = config.mediaPlayerModel;
    const dashMetrics = config.dashMetrics;
    //const settings = config.settings;

    let instance,
        logger,
        fragmentDict,
        abandonDict,
        bolaStateDict,
        throughputArray;

    function setup() {
        logger = Debug(context).getInstance().getLogger(instance);
        reset();
    }

    function setFragmentRequestDict(type, id) {
        fragmentDict[type] = fragmentDict[type] || {};
        fragmentDict[type][id] = fragmentDict[type][id] || {};
    }

    function storeLastRequestThroughputByType(type, throughput) {
        throughputArray[type] = throughputArray[type] || [];
        throughputArray[type].push(throughput);
    }

    function utilitiesFromBitrates(bitrates) {
        return bitrates.map(b => Math.log(b));
        // no need to worry about offset, utilities will be offset (uniformly) anyway later
    }

    function calculateBolaParameters(stableBufferTime, bitrates, utilities) {
        const highestUtilityIndex = utilities.reduce((highestIndex, u, uIndex) => (u > utilities[highestIndex] ? uIndex : highestIndex), 0);

        if (highestUtilityIndex === 0) {
            // if highestUtilityIndex === 0, then always use lowest bitrate
            return null;
        }

        const bufferTime = Math.max(stableBufferTime, MINIMUM_BUFFER_S + MINIMUM_BUFFER_PER_BITRATE_LEVEL_S * bitrates.length);

        // TODO: Investigate if following can be better if utilities are not the default Math.log utilities.
        // If using Math.log utilities, we can choose Vp and gp to always prefer bitrates[0] at minimumBufferS and bitrates[max] at bufferTarget.
        // (Vp * (utility + gp) - bufferLevel) / bitrate has the maxima described when:
        // Vp * (utilities[0] + gp - 1) === minimumBufferS and Vp * (utilities[max] + gp - 1) === bufferTarget
        // giving:
        const gp = (utilities[highestUtilityIndex] - 1) / (bufferTime / MINIMUM_BUFFER_S - 1);
        const Vp = MINIMUM_BUFFER_S / gp;
        // note that expressions for gp and Vp assume utilities[0] === 1, which is true because of normalization

        return { gp: gp, Vp: Vp };
    }

    function getInitialBolaState(rulesContext) {
        const initialState = {};
        const mediaInfo = rulesContext.getMediaInfo();
        const bitrates = mediaInfo.bitrateList.map(b => b.bandwidth);
        let utilities = utilitiesFromBitrates(bitrates);
        utilities = utilities.map(u => u - utilities[0] + 1); // normalize
        const stableBufferTime = mediaPlayerModel.getStableBufferTime();
        const params = calculateBolaParameters(stableBufferTime, bitrates, utilities);

        if (!params) {
            // only happens when there is only one bitrate level
            initialState.state = BOLA_STATE_ONE_BITRATE;
        } else {
            initialState.state = BOLA_STATE_STARTUP;

            initialState.bitrates = bitrates;
            initialState.utilities = utilities;
            initialState.stableBufferTime = stableBufferTime;
            initialState.Vp = params.Vp;
            initialState.gp = params.gp;

            initialState.lastQuality = 0;
            clearBolaStateOnSeek(initialState);
        }

        return initialState;
    }

    function clearBolaStateOnSeek(bolaState) {
        bolaState.placeholderBuffer = 0;
        bolaState.mostAdvancedSegmentStart = NaN;
        bolaState.lastSegmentWasReplacement = false;
        bolaState.lastSegmentStart = NaN;
        bolaState.lastSegmentDurationS = NaN;
        bolaState.lastSegmentRequestTimeMs = NaN;
        bolaState.lastSegmentFinishTimeMs = NaN;
    }

    function checkBolaStateStableBufferTime(bolaState, mediaType) {
        const stableBufferTime = mediaPlayerModel.getStableBufferTime();
        if (bolaState.stableBufferTime !== stableBufferTime) {
            const params = calculateBolaParameters(stableBufferTime, bolaState.bitrates, bolaState.utilities);
            if (params.Vp !== bolaState.Vp || params.gp !== bolaState.gp) {
                // correct placeholder buffer using two criteria:
                // 1. do not change effective buffer level at effectiveBufferLevel === MINIMUM_BUFFER_S ( === Vp * gp )
                // 2. scale placeholder buffer by Vp subject to offset indicated in 1.

                const bufferLevel = dashMetrics.getCurrentBufferLevel(mediaType);
                let effectiveBufferLevel = bufferLevel + bolaState.placeholderBuffer;

                effectiveBufferLevel -= MINIMUM_BUFFER_S;
                effectiveBufferLevel *= params.Vp / bolaState.Vp;
                effectiveBufferLevel += MINIMUM_BUFFER_S;

                bolaState.stableBufferTime = stableBufferTime;
                bolaState.Vp = params.Vp;
                bolaState.gp = params.gp;
                bolaState.placeholderBuffer = Math.max(0, effectiveBufferLevel - bufferLevel);
            }
        }
    }

    function getBolaState(rulesContext) {
        const mediaType = rulesContext.getMediaType();
        let bolaState = bolaStateDict[mediaType];
        if (!bolaState) {
            bolaState = getInitialBolaState(rulesContext);
            bolaStateDict[mediaType] = bolaState;
        } else if (bolaState.state !== BOLA_STATE_ONE_BITRATE) {
            checkBolaStateStableBufferTime(bolaState, mediaType);
        }
        return bolaState;
    }

    function getQualityFromBufferLevel(bolaState, bufferLevel, throughput, segmentDuration) {
        const bitrateCount = bolaState.bitrates.length;
        let quality = NaN;
        let bitrate = NaN;
        let prev_bitrate = NaN;
        let LABLevel = bufferLevel;
        let maxIte = bitrateCount;

        while (isNaN(bitrate) || bitrate != prev_bitrate) {
            let score = NaN;
            for (let i = 0; i < bitrateCount; ++i) {
                let s = (bolaState.Vp * (bolaState.utilities[i] + bolaState.gp) - LABLevel) / bolaState.bitrates[i];
                if (isNaN(score) || s >= score) {
                    score = s;
                    quality = i;
                }
            }
	    prev_bitrate = bitrate;
	    bitrate = bolaState.bitrates[quality];
	    LABLevel = bufferLevel + (1 - bitrate / throughput / 1000) * segmentDuration;
            //logger.info('[LABola] while loop...');
            maxIte = maxIte - 1;
            if (maxIte < 0) {
                break;
            }
        }
        logger.info('[LABAbandon] bufferLevel: ' + bufferLevel + 's, LABufferLevel: ' + LABLevel + 's');
        logger.info('[LABAbandon] bitrate: ' + bitrate / 1000 + 'kbps, throughput: ' + throughput + 'kbps, segmenDuration: ' + segmentDuration + 's, quality: ' + quality);
        return quality;
    }

    function shouldAbandon(rulesContext) {
        const switchRequest = SwitchRequest(context).create(SwitchRequest.NO_CHANGE, {name: AbandonRequestsRule.__dashjs_factory_name});

        if (!rulesContext || !rulesContext.hasOwnProperty('getMediaInfo') || !rulesContext.hasOwnProperty('getMediaType') || !rulesContext.hasOwnProperty('getCurrentRequest') ||
            !rulesContext.hasOwnProperty('getRepresentationInfo') || !rulesContext.hasOwnProperty('getAbrController')) {
            return switchRequest;
        }

        const mediaInfo = rulesContext.getMediaInfo();
        const mediaType = rulesContext.getMediaType();
        const streamInfo = rulesContext.getStreamInfo();
        const streamId = streamInfo ? streamInfo.id : null;
        const req = rulesContext.getCurrentRequest();

        if (!isNaN(req.index)) {
            setFragmentRequestDict(mediaType, req.index);

	    //const stableBufferTime = mediaPlayerModel.getStableBufferTime();
            const bufferLevel = dashMetrics.getCurrentBufferLevel(mediaType);
            //if ( bufferLevel > stableBufferTime ) {
            //    return switchRequest;
            //}

            const fragmentInfo = fragmentDict[mediaType][req.index];
            if (fragmentInfo === null || req.firstByteDate === null || abandonDict.hasOwnProperty(fragmentInfo.id)) {
                return switchRequest;
            }

            //setup some init info based on first progress event
            if (fragmentInfo.firstByteTime === undefined) {
                throughputArray[mediaType] = [];
                fragmentInfo.firstByteTime = req.firstByteDate.getTime();
                fragmentInfo.segmentDuration = req.duration;
                fragmentInfo.bytesTotal = req.bytesTotal;
                fragmentInfo.id = req.index;
            }
            fragmentInfo.bytesLoaded = req.bytesLoaded;
            fragmentInfo.elapsedTime = new Date().getTime() - fragmentInfo.firstByteTime;

            if (fragmentInfo.bytesLoaded > 0 && fragmentInfo.elapsedTime > 0) {
                storeLastRequestThroughputByType(mediaType, Math.round(fragmentInfo.bytesLoaded * 8 / fragmentInfo.elapsedTime));
            }

            if (throughputArray[mediaType].length >= MIN_LENGTH_TO_AVERAGE &&
                fragmentInfo.elapsedTime > GRACE_TIME_THRESHOLD &&
                fragmentInfo.bytesLoaded < fragmentInfo.bytesTotal) {

                const abrController = rulesContext.getAbrController();
                //const throughputHistory = abrController.getThroughputHistory();
                const totalSampledValue = throughputArray[mediaType].reduce((a, b) => a + b, 0);
                //const throughput = throughputHistory.getAverageThroughput(mediaType, isDynamic);
		
                fragmentInfo.measuredBandwidthInKbps = Math.round(totalSampledValue / throughputArray[mediaType].length); // ### This line requires more thought. Maybe we need a better throughput predictor.
                fragmentInfo.estimatedTimeOfDownload = +((fragmentInfo.bytesTotal * 8 / fragmentInfo.measuredBandwidthInKbps) / 1000).toFixed(2);

                if ( fragmentInfo.estimatedTimeOfDownload < fragmentInfo.segmentDuration * ABANDON_MULTIPLIER || rulesContext.getRepresentationInfo().quality === 0 ) {
                    return switchRequest;
                } else if (!abandonDict.hasOwnProperty(fragmentInfo.id)) {


		    const bolaState = getBolaState(rulesContext);
                    const newQuality = getQualityFromBufferLevel(bolaState, bufferLevel - segmentDuration, fragmentInfo.measuredBandwidthInKbps, segmentDuration);
                    const bytesRemaining = fragmentInfo.bytesTotal - fragmentInfo.bytesLoaded;
                    const bitrateList = abrController.getBitrateList(mediaInfo);
		    const segmentDuration = rulesContext.getRepresentationInfo().fragmentDuration;
                    //const quality = abrController.getQualityForBitrate(mediaInfo, fragmentInfo.measuredBandwidthInKbps * settings.get().streaming.abr.bandwidthSafetyFactor, streamId);
                    //const minQuality = abrController.getMinAllowedIndexFor(mediaType, streamId);
                    //const newQuality = (minQuality !== undefined) ? Math.max(minQuality, quality) : quality;
                    const estimateOtherBytesTotal = fragmentInfo.bytesTotal * bitrateList[newQuality].bitrate / bitrateList[abrController.getQualityFor(mediaType, streamId)].bitrate;

                    if (bytesRemaining > estimateOtherBytesTotal) {
                        switchRequest.quality = newQuality;
                        switchRequest.reason.throughput = fragmentInfo.measuredBandwidthInKbps;
                        switchRequest.reason.fragmentID = fragmentInfo.id;
                        switchRequest.reason.rule = this.getClassName();
                        abandonDict[fragmentInfo.id] = fragmentInfo;
                        logger.debug('[' + mediaType + '] frag id',fragmentInfo.id,' is asking to abandon and switch to quality to ', newQuality, ' measured bandwidth was', fragmentInfo.measuredBandwidthInKbps);
                        delete fragmentDict[mediaType][fragmentInfo.id];
                    }
                }
            } else if (fragmentInfo.bytesLoaded === fragmentInfo.bytesTotal) {
                delete fragmentDict[mediaType][fragmentInfo.id];
            }
        }

        return switchRequest;
    }

    function reset() {
        fragmentDict = {};
        abandonDict = {};
        throughputArray = [];
    }

    instance = {
        shouldAbandon: shouldAbandon,
        reset: reset
    };

    setup();

    return instance;
}

AbandonRequestsRule.__dashjs_factory_name = 'AbandonRequestsRule';
export default FactoryMaker.getClassFactory(AbandonRequestsRule);
