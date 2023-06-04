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

/*global dashjs*/

let LABRule;

function LABRuleClass() {

    let factory = dashjs.FactoryMaker;
    let SwitchRequest = factory.getClassFactoryByName('SwitchRequest');
    let DashMetrics = factory.getSingletonFactoryByName('DashMetrics');
    let DashManifestModel = factory.getSingletonFactoryByName('DashManifestModel');
    let StreamController = factory.getSingletonFactoryByName('StreamController');
    let Debug = factory.getSingletonFactoryByName('Debug');

    let context = this.context;
    let instance,
        logger;

    function setup() {
        logger = Debug(context).getInstance().getLogger(instance);
    }

    function getBytesLength(request) {
        return request.trace.reduce(function (a, b) {
            return a + b.b[0];
        }, 0);
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

    function getInitialState(rulesContext) {
        const initialState = {};
        const mediaInfo = rulesContext.getMediaInfo();
        const bitrates = mediaInfo.bitrateList.map(b => b.bandwidth);
        let utilities = utilitiesFromBitrates(bitrates);
        utilities = utilities.map(u => u - utilities[0] + 1); // normalize
        const stableBufferTime = mediaPlayerModel.getStableBufferTime();
        const params = calculateBolaParameters(stableBufferTime, bitrates, utilities);

        initialState.bitrates = bitrates;
        initialState.utilities = utilities;
        initialState.stableBufferTime = stableBufferTime;
        initialState.Vp = params.Vp;
        initialState.gp = params.gp;

        initialState.lastQuality = 0;
        clearStateOnSeek(initialState);

        return initialState;
    }

    function clearStateOnSeek(state) {
        state.placeholderBuffer = 0;
        state.mostAdvancedSegmentStart = NaN;
        state.lastSegmentWasReplacement = false;
        state.lastSegmentStart = NaN;
        state.lastSegmentDurationS = NaN;
        state.lastSegmentRequestTimeMs = NaN;
        state.lastSegmentFinishTimeMs = NaN;
    }

    function getState(rulesContext) {
        const mediaType = rulesContext.getMediaType();
        let state = stateDict[mediaType];
        if (!state) {
            state = getInitialState(rulesContext);
            stateDict[mediaType] = state;
        }
        return state;
    }

    // The core idea of LAB
    function getQualityFromBufferLevel(state, bufferLevel, throughput, segmentDuration) {
        const bitrateCount = state.bitrates.length;
        let quality = NaN;
        let bitrate = NaN;
        let prev_bitrate = NaN;
        let LABLevel = bufferLevel;

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
	    bitrate = state.bitrates[quality];
	    LABLevel = bufferLevel + (1 - bitrate / throughput / 1000) * segmentDuration;
        }
        logger.debug('[LABRule] bufferLevel: ' + bufferLevel + 's, LABufferLevel: ' + LABLevel + 's');
        logger.debug('[LABRule] bufferLevel: ' + bufferLevel + 's, LABufferLevel: ' + LABLevel + 's');
        logger.debug('[LABRule] bitrate: ' + bitrate / 1000 + 'kbps, throughput: ' + throughput + 'kbps, segmenDuration: ' + segmentDuration + 's, quality: ' + quality);
        logger.debug('[LABRule] bitrate: ' + bitrate / 1000 + 'kbps, throughput: ' + throughput + 'kbps, segmenDuration: ' + segmentDuration + 's, quality: ' + quality);
        return quality;
    }

    function getMaxIndex(rulesContext) {

        let mediaType = rulesContext.getMediaInfo().type;

        let dashMetrics = DashMetrics(context).getInstance();
        let dashManifest = DashManifestModel(context).getInstance();
        let streamController = StreamController(context).getInstance();
        let abrController = rulesContext.getAbrController();
        let current = abrController.getQualityFor(mediaType, streamController.getActiveStreamInfo().id);

        let state = getState(rulesContext);
        let bufferLevel = dashMetrics.getCurrentBufferLevel(mediaType);
        let throughputHistory = abrController.getThroughputHistory();
        let throughput = throughputHistory.getAverageThroughput(mediaType, isDynamic);
        let segmentDuration = rulesContext.getRepresentationInfo().fragmentDuration;

        let requests = dashMetrics.getHttpRequests(mediaType),
            lastRequest = null,
            currentRequest = null,
            downloadTime,
            totalTime,
            calculatedBandwidth,
            currentBandwidth,
            latencyInBandwidth,
            switchUpRatioSafetyFactor,
            currentRepresentation,
            count,
            bandwidths = [],
            i,
            quality = SwitchRequest.NO_CHANGE,
            priority = SwitchRequest.PRIORITY.DEFAULT,
            totalBytesLength = 0;

        latencyInBandwidth = true;
        switchUpRatioSafetyFactor = 1.5;
        logger.debug("[CustomRules][" + mediaType + "][LABRule] Checking download ratio rule... (current = " + current + ")");

        if (!requests) {
            logger.debug("[CustomRules][" + mediaType + "][LABRule] No metrics, bailing.");
            return SwitchRequest(context).create();
        }


        // Get last valid request
        i = requests.length - 1;
        while (i >= 0 && lastRequest === null) {
            currentRequest = requests[i];
            if (currentRequest._tfinish && currentRequest.trequest && currentRequest.tresponse && currentRequest.trace && currentRequest.trace.length > 0) {
                lastRequest = requests[i];
            }
            i--;
        }

        if (lastRequest === null) {
            logger.debug("[CustomRules][" + mediaType + "][LABRule] No valid requests made for this stream yet, bailing.");
            return SwitchRequest(context).create();
        }

        if (lastRequest.type !== 'MediaSegment') {
            logger.debug("[CustomRules][" + mediaType + "][LABRule] Last request is not a media segment, bailing.");
            return SwitchRequest(context).create();
        }

        quality = getQualityFromLABLevel(state, bufferLevel, throughput, segmentDuration);
        priority = SwitchRequest.PRIORITY.STRONG;

        logger.debug("[CustomRules] SwitchRequest: quality=" + q + "/" + (count - 1) + " (" + bandwidths[quality] + ")"/* + ", priority=" + priority*/);
        return SwitchRequest(context).create(quality, { name: LABRuleClass.__dashjs_factory_name }, priority);
    }

    instance = {
        getMaxIndex: getMaxIndex
    };

    setup();

    return instance;
}

LABRuleClass.__dashjs_factory_name = 'LABRule';
LABRule = dashjs.FactoryMaker.getClassFactory(LABRuleClass);
