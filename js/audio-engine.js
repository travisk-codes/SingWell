/**
 * AudioEngine wraps the Web Audio API to provide:
 *   - Microphone capture with an AnalyserNode for pitch detection
 *   - Reference tone playback (sine wave oscillator)
 *   - RMS volume metering
 *
 * Microphone audio is routed to the AnalyserNode only — it is NOT
 * connected to the audio destination, so the user won't hear their
 * own voice fed back through the speakers.
 */
export class AudioEngine {
  constructor() {
    this.audioContext = null;
    this.microphoneStream = null;
    this.microphoneSourceNode = null;
    this.analyserNode = null;
    this.timeDomainBuffer = null;
  }

  /**
   * Create the AudioContext, request microphone permission, and wire
   * up the analyser node. Must be called from a user-gesture handler
   * (click/tap) so the browser allows the AudioContext to start.
   */
  async initialize() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      throw new Error('Web Audio API is not supported in this browser.');
    }

    this.audioContext = new AudioContextClass();

    // Resume in case the browser suspended the context
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    // Request mic with processing disabled so we get the raw signal
    this.microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    this.microphoneSourceNode = this.audioContext.createMediaStreamSource(
      this.microphoneStream
    );

    this.analyserNode = this.audioContext.createAnalyser();
    this.analyserNode.fftSize = 4096;

    this.microphoneSourceNode.connect(this.analyserNode);
    // Intentionally NOT connecting to audioContext.destination

    this.timeDomainBuffer = new Float32Array(this.analyserNode.fftSize);
  }

  /**
   * Fill and return the time-domain sample buffer from the analyser.
   * The returned Float32Array is reused between calls.
   */
  getTimeDomainData() {
    this.analyserNode.getFloatTimeDomainData(this.timeDomainBuffer);
    return this.timeDomainBuffer;
  }

  /** The sample rate of the underlying AudioContext. */
  getSampleRate() {
    return this.audioContext.sampleRate;
  }

  /**
   * Compute the current RMS (root mean square) volume from the
   * time-domain buffer. Returns a value roughly in 0..1 for typical
   * microphone input levels.
   */
  computeRmsVolume() {
    this.analyserNode.getFloatTimeDomainData(this.timeDomainBuffer);
    let sumOfSquares = 0;
    for (let i = 0; i < this.timeDomainBuffer.length; i++) {
      sumOfSquares += this.timeDomainBuffer[i] * this.timeDomainBuffer[i];
    }
    return Math.sqrt(sumOfSquares / this.timeDomainBuffer.length);
  }

  /**
   * Play a short sine-wave reference tone at the given frequency.
   * Uses a quick fade-in/out to avoid audible clicks.
   *
   * @param {number} frequencyHz
   * @param {number} durationSeconds
   * @param {number} volume - gain (0..1)
   */
  playReferenceTone(frequencyHz, durationSeconds = 1.0, volume = 0.12) {
    const oscillator = this.audioContext.createOscillator();
    const gainNode = this.audioContext.createGain();
    const now = this.audioContext.currentTime;

    oscillator.type = 'sine';
    oscillator.frequency.value = frequencyHz;

    // Smooth fade in/out to avoid clicks
    const fadeTime = 0.04;
    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(volume, now + fadeTime);
    gainNode.gain.setValueAtTime(volume, now + durationSeconds - fadeTime);
    gainNode.gain.linearRampToValueAtTime(0, now + durationSeconds);

    oscillator.connect(gainNode);
    gainNode.connect(this.audioContext.destination);

    oscillator.start(now);
    oscillator.stop(now + durationSeconds);
  }

  /**
   * Play a short click/tick sound for count-in beats.
   */
  playCountInClick() {
    this.playReferenceTone(880, 0.08, 0.1);
  }

  /** Release all audio resources. */
  shutdown() {
    if (this.microphoneStream) {
      this.microphoneStream.getTracks().forEach((track) => track.stop());
    }
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
    }
    this.audioContext = null;
    this.microphoneStream = null;
    this.microphoneSourceNode = null;
    this.analyserNode = null;
  }
}
