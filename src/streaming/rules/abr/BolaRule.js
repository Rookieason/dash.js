/**
 * The copyright in this software is being made available under the BSD License,
 * included below. This software may be subject to other third party and contributor
 * rights, including patent rights, and no such rights are granted under this license.
 *
 * Copyright (c) 2016, Dash Industry Forum.
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

// For a description of the BOLA adaptive bitrate (ABR) algorithm, see http://arxiv.org/abs/1601.06748

import SwitchRequest from '../SwitchRequest';
import FactoryMaker from '../../../core/FactoryMaker';
import Debug from '../../../core/Debug';

const MINIMUM_BUFFER_S = 10; // BOLA should never add artificial delays if buffer is less than MINIMUM_BUFFER_S.
const MINIMUM_BUFFER_PER_BITRATE_LEVEL_S = 2;
// E.g. if there are 5 bitrates, BOLA switches to top bitrate at buffer = 10 + 5 * 2 = 20s.
// If Schedule Controller does not allow buffer to reach that level, it can be achieved through the placeholder buffer level.

function BolaRule(config) {

    config = config || {};
    const context = this.context;

    const dashMetrics = config.dashMetrics;
    const mediaPlayerModel = config.mediaPlayerModel;

    let instance,
        logger,
        bolaStateDict;

    function setup() {
        logger = Debug(context).getInstance().getLogger(instance);
        resetInitialSettings();

        //eventBus.on(MediaPlayerEvents.BUFFER_EMPTY, onBufferEmpty, instance);
        //eventBus.on(MediaPlayerEvents.PLAYBACK_SEEKING, onPlaybackSeeking, instance);
        //eventBus.on(MediaPlayerEvents.METRIC_ADDED, onMetricAdded, instance);
        //eventBus.on(MediaPlayerEvents.QUALITY_CHANGE_REQUESTED, onQualityChangeRequested, instance);
        //eventBus.on(MediaPlayerEvents.FRAGMENT_LOADING_ABANDONED, onFragmentLoadingAbandoned, instance);

        //eventBus.on(Events.MEDIA_FRAGMENT_LOADED, onMediaFragmentLoaded, instance);
    }

    function utilitiesFromBitrates(bitrates) {
        return bitrates.map(b => Math.log(b));
        // no need to worry about offset, utilities will be offset (uniformly) anyway later
    }

    // NOTE: in live streaming, the real buffer level can drop below minimumBufferS, but bola should not stick to lowest bitrate by using a placeholder buffer level
    function calculateBolaParameters(stableBufferTime, bitrates, utilities) {
        const highestUtilityIndex = utilities.reduce((highestIndex, u, uIndex) => (u > utilities[highestIndex] ? uIndex : highestIndex), 0);

        if (highestUtilityIndex === 0) {
            // if highestUtilityIndex === 0, then always use lowest bitrate
            return null;
        }

        const bufferTime = Math.max(stableBufferTime, MINIMUM_BUFFER_S + MINIMUM_BUFFER_PER_BITRATE_LEVEL_S * bitrates.length);
        //const bufferTime = stableBufferTime;

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

        initialState.bitrates = bitrates;
        initialState.utilities = utilities;
        initialState.stableBufferTime = stableBufferTime;
        initialState.Vp = params.Vp;
        initialState.gp = params.gp;

        initialState.lastQuality = 0;
        clearBolaStateOnSeek(initialState);

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

    function getBolaState(rulesContext) {
        const mediaType = rulesContext.getMediaType();
        let bolaState = bolaStateDict[mediaType];
        if (!bolaState) {
            bolaState = getInitialBolaState(rulesContext);
            bolaStateDict[mediaType] = bolaState;
        }
        return bolaState;
    }

    // The core idea of BOLA.
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
            logger.info('[LABRule] while loop...');
            maxIte = maxIte - 1;
            if (maxIte < 0) {
                break;
            }
        }
        logger.info('[LABRule] bufferLevel: ' + bufferLevel + 's, LABufferLevel: ' + LABLevel + 's');
        logger.info('[LABRule] bitrate: ' + bitrate / 1000 + 'kbps, throughput: ' + throughput + 'kbps, segmenDuration: ' + segmentDuration + 's, quality: ' + quality);
        return quality;
    }
    
    function getMaxIndex(rulesContext) {
        const switchRequest = SwitchRequest(context).create();

        if (!rulesContext || !rulesContext.hasOwnProperty('getMediaInfo') || !rulesContext.hasOwnProperty('getMediaType') ||
            !rulesContext.hasOwnProperty('getScheduleController') || !rulesContext.hasOwnProperty('getStreamInfo') ||
            !rulesContext.hasOwnProperty('getAbrController') || !rulesContext.hasOwnProperty('useBufferOccupancyABR')) {
            return switchRequest;
        }
        const mediaType = rulesContext.getMediaType();
        const scheduleController = rulesContext.getScheduleController();
        const streamInfo = rulesContext.getStreamInfo();
        const abrController = rulesContext.getAbrController();
        const throughputHistory = abrController.getThroughputHistory();
        const isDynamic = streamInfo && streamInfo.manifestInfo && streamInfo.manifestInfo.isDynamic;
        const useBufferOccupancyABR = rulesContext.useBufferOccupancyABR();
        const segmentDuration = rulesContext.getRepresentationInfo().fragmentDuration;
        switchRequest.reason = switchRequest.reason || {};

        if (!useBufferOccupancyABR) {
            return switchRequest;
        }

        scheduleController.setTimeToLoadDelay(0);

        const bolaState = getBolaState(rulesContext);

        const bufferLevel = dashMetrics.getCurrentBufferLevel(mediaType);
        const throughput = throughputHistory.getAverageThroughput(mediaType, isDynamic);
        const latency = throughputHistory.getAverageLatency(mediaType);
        let quality;

        switchRequest.reason.state = bolaState.state;
        switchRequest.reason.throughput = throughput;
        switchRequest.reason.latency = latency;

        if (isNaN(throughput)) { // isNaN(throughput) === isNaN(safeThroughput) === isNaN(latency)
            // still starting up - not enough information
            return switchRequest;
        }

        quality = getQualityFromBufferLevel(bolaState, bufferLevel, throughput, segmentDuration);

        switchRequest.quality = quality;
        switchRequest.reason.throughput = throughput;
        switchRequest.reason.latency = latency;
        switchRequest.reason.bufferLevel = bufferLevel;
        switchRequest.reason.placeholderBuffer = bolaState.placeholderBuffer;
        switchRequest.priority = switchRequest.PRIORITY.STRONG;
        //switchRequest.delay = 0;

        bolaState.lastQuality = quality;

        return switchRequest;
    }

    function resetInitialSettings() {
        bolaStateDict = {};
    }

    function reset() {
        resetInitialSettings();

        //eventBus.off(MediaPlayerEvents.BUFFER_EMPTY, onBufferEmpty, instance);
        //eventBus.off(MediaPlayerEvents.PLAYBACK_SEEKING, onPlaybackSeeking, instance);
        //eventBus.off(MediaPlayerEvents.METRIC_ADDED, onMetricAdded, instance);
        //eventBus.off(MediaPlayerEvents.QUALITY_CHANGE_REQUESTED, onQualityChangeRequested, instance);
        //eventBus.off(MediaPlayerEvents.FRAGMENT_LOADING_ABANDONED, onFragmentLoadingAbandoned, instance);

        //eventBus.off(Events.MEDIA_FRAGMENT_LOADED, onMediaFragmentLoaded, instance);
    }

    instance = {
        getMaxIndex: getMaxIndex,
        reset: reset
    };

    setup();
    return instance;
}

BolaRule.__dashjs_factory_name = 'BolaRule';
export default FactoryMaker.getClassFactory(BolaRule);
