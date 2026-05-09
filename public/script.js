"use strict";

window.AudioContext = window.AudioContext || window.webkitAudioContext;

const frokImg = document.getElementById("mr-frok");

class DankVizualizer {
  /**
   * @type{HTMLAudioElement}
   */
  #audioEl = null;
  /**
   * @type {AudioContext}
   */
  #audioContext = null;
  /**
   * @type{MediaElementAudioSourceNode}
   */
  #mediaStreamSource = null;
  /**
   * @type{AnalyserNode}
   */
  #analyzer = null;
  #dbCount = 0;
  #dbTot = 0;
  #dbAvg = 0;
  #intID = 0;

  /**
   * @param {HTMLAudioElement} audioEl
   * @param {number} [updateIntervalMS=250]
   */
  constructor(audioEl, updateIntervalMS = 250) {
    this.#audioEl = audioEl;
    this.updateIntervalMS = updateIntervalMS;
  }

  getAnalyzer() {
    return this.#analyzer;
  }

  runLoop() {
    if (this.#audioContext === null) {
      this.#audioContext = new AudioContext();
    }
    this.#mediaStreamSource = this.#audioContext.createMediaElementSource(
      this.#audioEl,
    );
    this.#mediaStreamSource.connect(this.#audioContext.destination);
    this.#analyzer = this.#audioContext.createAnalyser();
    this.#analyzer.fftSize = 2048;
    this.#mediaStreamSource.connect(this.#analyzer);

    // ahem ahem: wtf
    const classifier = new AudioClassifier(this.#analyzer);
    const noteProcessor = new AudioNoteProcessor(this.#analyzer);
    this.#intID = setInterval(() => {
      const pepe = noteProcessor.process();
      const { freq, db, note } = pepe;
      this.#dbCount++;
      this.#dbTot += db;
      this.#dbAvg = this.#dbTot / this.#dbCount;

      const result = classifier.analyze();
      console.log(result, this.#dbAvg, pepe);
      if (
        result === AudioClassifier.CLASSIFICATIONS.VOCAL &&
        db >= this.#dbAvg
      ) {
        frokImg.src = "/mr_frok_mouth_opened.png";
      } else {
        frokImg.src = "/mr_frok_mouth_closed.png";
      }
    }, this.updateIntervalMS);

    this.#audioEl.play();
    this.#audioEl.volume = 1;
  }

  stopLoop() {
    this.#audioEl.pause();
    clearInterval(this.#intID);
  }
}

/**
 * Vocal vs Instrument Classifier (Heuristic Approach)
 * Note: This requires a running AudioContext and AnalyserNode
 */
class AudioClassifier {
  constructor(analyserNode) {
    this.analyser = analyserNode;
    this.bufferLength = this.analyser.frequencyBinCount;
    this.dataArray = new Uint8Array(this.bufferLength);
    // this.buffer = new Float32Array(this.bufferLength)
    // Arrays to hold our two types of audio data
    this.freqData = new Uint8Array(this.bufferLength);
    this.timeData = new Float32Array(this.bufferLength);
  }

  static CLASSIFICATIONS = {
    SILENCE: 0, // Shush
    INST_BASS: 1, // Bass Instrument (Sub-Bass/Kick)
    INST_HI: 2, // Hi/Treble Instrument (Percussion/High Synth)
    INST_MID: 3, // Mid instrument (Guitar/Piano/Synth)
    VOCAL: 4, // Likely Human Vocal
  };

  /**
   * @returns {typeof AudioClassifier.CLASSIFICATIONS}
   */
  analyze() {
    this.analyser.getByteFrequencyData(this.dataArray);
    this.analyser.getFloatTimeDomainData(this.timeData);

    let totalAmplitude = 0;
    let weightedSum = 0;
    let peakAmplitude = 0;
    let peakFrequencyIndex = 0;

    for (let i = 0; i < this.bufferLength; i++) {
      const amplitude = this.dataArray[i];
      totalAmplitude += amplitude;
      weightedSum += i * amplitude;

      if (amplitude > peakAmplitude) {
        peakAmplitude = amplitude;
        peakFrequencyIndex = i;
      }
    }

    if (totalAmplitude === 0) {
      return AudioClassifier.SILENCE;
    }

    const nyquist = 22050; // Standard for 44.1kHz
    const fundamental = (peakFrequencyIndex * nyquist) / this.bufferLength;

    /**
     * CLASSIFICATION LOGIC
     * Human Vocals typically have:
     * - Fundamentals between 80Hz and 1100Hz
     * - High energy in the "presence" range (2kHz - 4kHz)
     * - Non-tonal noise bursts (consonants)
     */

    // Check if fundamental is in the human range
    const isHumanPitchRange = fundamental > 80 && fundamental < 1100;

    // Check for "Human Presence" (The 2k-4k bump)
    const presenceStart = Math.ceil((2000 * this.bufferLength) / nyquist);
    const presenceEnd = Math.ceil((4000 * this.bufferLength) / nyquist);
    let presenceEnergy = 0;
    for (let i = presenceStart; i < presenceEnd; i++) {
      presenceEnergy += this.dataArray[i];
    }
    const presenceRatio = presenceEnergy / totalAmplitude;

    if (fundamental < 60) {
      return AudioClassifier.CLASSIFICATIONS.INST_BASS;
    } else if (isHumanPitchRange && presenceRatio > 0.15) {
      return AudioClassifier.CLASSIFICATIONS.VOCAL;
    } else if (fundamental > 2000) {
      return AudioClassifier.CLASSIFICATIONS.INST_HI;
    } else {
      return AudioClassifier.CLASSIFICATIONS.INST_MID;
    }
  }
}

class AudioNoteProcessor {
  constructor(analyserNode) {
    if (!analyserNode) {
      throw new Error(
        "An AnalyserNode is required to initialize AudioNoteProcessor.",
      );
    }

    this.analyser = analyserNode;
    this.buflen = this.analyser.fftSize;
    this.buf = new Float32Array(this.buflen);

    this.noteStrings = [
      "C",
      "C#",
      "D",
      "D#",
      "E",
      "F",
      "F#",
      "G",
      "G#",
      "A",
      "A#",
      "B",
    ];
  }

  process() {
    this.analyser.getFloatTimeDomainData(this.buf);
    const sampleRate = this.analyser.context.sampleRate;
    const result = this.#autoCorrelate(this.buf, sampleRate);

    if (result.frequency === -1) {
      return { freq: -1, db: result.db, note: null };
    }

    const noteNumber = this.#noteFromPitch(result.frequency);

    return {
      freq: result.frequency,
      db: result.db,
      note: this.noteStrings[noteNumber % 12],
      noteNumber: noteNumber,
      detune: this.#centsOffFromPitch(result.frequency, noteNumber),
    };
  }

  #autoCorrelate(buf, sampleRate) {
    const SIZE = buf.length;
    let rms = 0;
    for (let i = 0; i < SIZE; i++) {
      rms += buf[i] * buf[i];
    }
    rms = Math.sqrt(rms / SIZE);

    // Decibel calculation
    const db = rms > 0 ? 20 * Math.log10(rms) : -100;

    // Silence threshold (approx -40dB)
    if (rms < 0.01) return { frequency: -1, db };

    // ACF2 Algorithm
    let r1 = 0,
      r2 = SIZE - 1,
      thres = 0.2;
    for (let i = 0; i < SIZE / 2; i++)
      if (Math.abs(buf[i]) < thres) {
        r1 = i;
        break;
      }
    for (let i = 1; i < SIZE / 2; i++)
      if (Math.abs(buf[SIZE - i]) < thres) {
        r2 = SIZE - i;
        break;
      }

    const slice = buf.slice(r1, r2);
    const S_SIZE = slice.length;
    const c = new Array(S_SIZE).fill(0);
    for (let i = 0; i < S_SIZE; i++) {
      for (let j = 0; j < S_SIZE - i; j++)
        c[i] = c[i] + slice[j] * slice[j + i];
    }

    let d = 0;
    while (c[d] > c[d + 1]) d++;
    let maxval = -1,
      maxpos = -1;
    for (let i = d; i < S_SIZE; i++) {
      if (c[i] > maxval) {
        maxval = c[i];
        maxpos = i;
      }
    }

    let T0 = maxpos;
    const x1 = c[T0 - 1],
      x2 = c[T0],
      x3 = c[T0 + 1];
    const a = (x1 + x3 - 2 * x2) / 2;
    const b = (x3 - x1) / 2;
    if (a) T0 = T0 - b / (2 * a);

    return { frequency: sampleRate / T0, db };
  }

  #noteFromPitch(frequency) {
    const noteNum = 12 * (Math.log(frequency / 440) / Math.log(2));
    return Math.round(noteNum) + 69;
  }

  #frequencyFromNoteNumber(note) {
    return 440 * Math.pow(2, (note - 69) / 12);
  }

  #centsOffFromPitch(frequency, note) {
    return Math.floor(
      (1200 * Math.log(frequency / this.#frequencyFromNoteNumber(note))) /
        Math.log(2),
    );
  }
}

function f1(freq) {
  return freq >= 300 && freq <= 900;
}

function f2(freq) {
  return freq >= 800 && freq <= 3000;
}

let freqs = [];
let notesFreqsNames = {
  C: 16.351,
  "C#": 17.324,
  D: 18.354,
  "D#": 19.445,
  E: 20.601,
  F: 21.827,
  "F#": 23.124,
  G: 24.499,
  "G#": 25.956,
  A: 27.5,
  "A#": 29.135,
  B: 30.868,
};

let notesFreqs = {};

function fillNotes() {
  for (let i = 0; i <= 8; i++) {
    for (const note in notesFreqsNames) {
      notesFreqs[`${Math.ceil(notesFreqsNames[note] * Math.pow(2, i))}`] = true;
    }
  }
}

fillNotes();

function isMusicalNote(freq) {
  return !!notesFreqs[freq];
}
