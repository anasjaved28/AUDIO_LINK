/**
 * A custom AudioWorkletProcessor that acts as a simple, low-latency audio
 * limiter and RMS meter. It prevents audio from distorting and provides
 * visual feedback for the UI.
 */
class LimiterProcessor extends AudioWorkletProcessor {
  // Define the audio parameters that can be controlled from the main thread.
  static get parameterDescriptors() {
    return [
      { name: "preGain", defaultValue: 1.0, automationRate: "a-rate" },
      { name: "threshold", defaultValue: 0.95, automationRate: "a-rate" },
      { name: "release", defaultValue: 0.005, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    this._rmsAccumulator = 0;
    this._rmsSampleCount = 0;
    this._framesSinceUpdate = 0;
    this._lastGain = 1.0;
    this.METER_UPDATE_INTERVAL = 128; // Send an update every 128 frames
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;

    const preGain = parameters.preGain;
    const threshold = parameters.threshold;
    const release = parameters.release[0];

    for (let channel = 0; channel < input.length; channel++) {
      const inputChannel = input[channel];
      const outputChannel = output[channel];
      for (let i = 0; i < inputChannel.length; i++) {
        const pGain = preGain.length > 1 ? preGain[i] : preGain[0];
        const thresh = threshold.length > 1 ? threshold[i] : threshold[0];

        const sample = inputChannel[i] * pGain;
        const sampleAbs = Math.abs(sample);

        // Apply a soft-knee limiter
        let limitedSample = sample;
        if (sampleAbs > thresh) {
          const overshoot = sampleAbs - thresh;
          const reduction = overshoot / (1 + overshoot * 8);
          limitedSample = Math.sign(sample) * (thresh + reduction);
        }

        // Apply light gain smoothing
        const targetGain = Math.min(1, thresh / Math.max(thresh, sampleAbs));
        this._lastGain += (targetGain - this._lastGain) * release;
        const finalSample = limitedSample * this._lastGain;

        outputChannel[i] = finalSample;

        // Accumulate for RMS metering
        this._rmsAccumulator += finalSample * finalSample;
        this._rmsSampleCount++;

        // Send RMS update to the main thread periodically
        if (++this._framesSinceUpdate >= this.METER_UPDATE_INTERVAL) {
          const rms = Math.sqrt(this._rmsAccumulator / this._rmsSampleCount);
          this.port.postMessage({ rms: rms });
          this._rmsAccumulator = 0;
          this._rmsSampleCount = 0;
          this._framesSinceUpdate = 0;
        }
      }
    }
    // Return true to keep the processor alive
    return true;
  }
}

registerProcessor("limiter-processor", LimiterProcessor);