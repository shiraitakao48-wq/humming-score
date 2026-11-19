
import abcjs from "abcjs";
import { Midi } from "@tonejs/midi";
import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";
import modelJsonUrl from "@spotify/basic-pitch/model/model.json?url";
import modelWeightsUrl from "@spotify/basic-pitch/model/group1-shard1of1.bin?url";
import "./style.css";

// ======================================
// アプリの状態
// ======================================

let mediaRecorder = null;
let audioChunks = [];
let audioBlob = null;
let audioBuffer = null;
let recordingStart = 0;
let timerInterval = null;
let notes = [];
let basicPitchPromise = null;
let tempoBpm = 120;
let tempoEstimateAvailable = false;

const MODEL_SAMPLE_RATE = 22050;
const CONTOUR_BINS_PER_SEMITONE = 3;
const NOTE_DURATIONS_BEATS = [
  0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8
];

// ======================================
// HTML要素
// ======================================

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const analyzeBtn = document.getElementById("analyzeBtn");
const audioPlayer = document.getElementById("audioPlayer");
const audioFile = document.getElementById("audioFile");
const recordStatus = document.getElementById("recordStatus");
const timer = document.getElementById("timer");
const analysisStatus = document.getElementById("analysisStatus");
const noteList = document.getElementById("noteList");
const sheetMusic = document.getElementById("sheetMusic");
const pdfBtn = document.getElementById("pdfBtn");
const midiBtn = document.getElementById("midiBtn");

// ======================================
// 1. マイク録音
// ======================================

startBtn.addEventListener("click", async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    audioChunks = [];

    const mimeType = MediaRecorder.isTypeSupported(
      "audio/webm;codecs=opus"
    )
      ? "audio/webm;codecs=opus"
      : "audio/webm";

    mediaRecorder = new MediaRecorder(
      stream,
      { mimeType }
    );

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = () => {
      audioBlob = new Blob(audioChunks, {
        type: mediaRecorder.mimeType
      });

      const audioUrl = URL.createObjectURL(audioBlob);

      audioPlayer.src = audioUrl;
      analyzeBtn.disabled = false;

      stream.getTracks().forEach(track => track.stop());

      recordStatus.textContent = "録音完了";
    };

    mediaRecorder.start();

    recordingStart = Date.now();

    recordStatus.textContent = "録音中...";

    startBtn.disabled = true;
    stopBtn.disabled = false;

    timerInterval = setInterval(() => {
      const seconds = Math.floor(
        (Date.now() - recordingStart) / 1000
      );

      const min = String(
        Math.floor(seconds / 60)
      ).padStart(2, "0");

      const sec = String(
        seconds % 60
      ).padStart(2, "0");

      timer.textContent = `${min}:${sec}`;
    }, 500);

  } catch (error) {
    console.error(error);

    alert(
      "マイクを利用できません。ブラウザのマイク使用許可を確認してください。"
    );
  }
});

// ======================================
// 2. 録音停止
// ======================================

stopBtn.addEventListener("click", () => {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
  }

  clearInterval(timerInterval);

  startBtn.disabled = false;
  stopBtn.disabled = true;
});

// ======================================
// 3. 音声ファイル読み込み
// ======================================

audioFile.addEventListener("change", async (event) => {
  const file = event.target.files[0];

  if (!file) return;

  audioBlob = file;

  audioPlayer.src = URL.createObjectURL(file);

  analyzeBtn.disabled = false;

  recordStatus.textContent = "音声ファイル読み込み完了";
});

// ======================================
// 4. 音声データの解析
// ======================================

async function decodeAudio(blob) {
  const context = new AudioContext();

  const arrayBuffer = await blob.arrayBuffer();

  const buffer = await context.decodeAudioData(
    arrayBuffer
  );

  await context.close();

  return buffer;
}

// ======================================
// 5. MIDI番号を音名に変換
// ======================================

function midiToName(midi) {

  const names = [
    "C", "C#", "D", "D#", "E", "F",
    "F#", "G", "G#", "A", "A#", "B"
  ];

  const name = names[midi % 12];

  const octave = Math.floor(midi / 12) - 1;

  return name + octave;
}

// ======================================
// 6. Basic Pitchによる音符抽出
// ======================================

function getBasicPitch() {
  if (!basicPitchPromise) {
    basicPitchPromise = Promise.all([
      import("@spotify/basic-pitch"),
      import("@tensorflow/tfjs")
    ]).then(([basicPitchModule, tf]) => {
      return tf.loadGraphModel(modelJsonUrl, {
        weightUrlConverter: async (weightFileName) => {
          if (!weightFileName.endsWith("group1-shard1of1.bin")) {
            throw new Error(`Basic Pitchのモデルファイルが不正です: ${weightFileName}`);
          }

          return modelWeightsUrl;
        }
      }).then(model => ({
        model: new basicPitchModule.BasicPitch(Promise.resolve(model)),
        addPitchBendsToNoteEvents: basicPitchModule.addPitchBendsToNoteEvents,
        noteFramesToTime: basicPitchModule.noteFramesToTime,
        outputToNotesPoly: basicPitchModule.outputToNotesPoly
      }));
    }).catch(error => {
      basicPitchPromise = null;
      throw error;
    });
  }

  return basicPitchPromise;
}

async function resampleToMono(buffer) {
  const length = Math.max(
    1,
    Math.ceil(buffer.duration * MODEL_SAMPLE_RATE)
  );
  const context = new OfflineAudioContext(
    1,
    length,
    MODEL_SAMPLE_RATE
  );
  const source = context.createBufferSource();

  source.buffer = buffer;
  source.connect(context.destination);
  source.start();

  return context.startRendering();
}

function median(values) {
  if (values.length === 0) return 0;

  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

async function extractNotes(buffer, onProgress) {
  const {
    model,
    addPitchBendsToNoteEvents,
    noteFramesToTime,
    outputToNotesPoly
  } = await getBasicPitch();
  const monoBuffer = await resampleToMono(buffer);
  const frames = [];
  const onsets = [];
  const contours = [];

  await model.evaluateModel(
    monoBuffer,
    (frameChunk, onsetChunk, contourChunk) => {
      frames.push(...frameChunk);
      onsets.push(...onsetChunk);
      contours.push(...contourChunk);
    },
    onProgress
  );

  const extractedNotes = noteFramesToTime(
    addPitchBendsToNoteEvents(
      contours,
      outputToNotesPoly(frames, onsets, 0.25, 0.25, 5, true, 1200, 80)
    )
  ).map(note => ({
    midi: Math.round(
      note.pitchMidi +
      median(note.pitchBends || []) / CONTOUR_BINS_PER_SEMITONE
    ),
    start: note.startTimeSeconds,
    duration: note.durationSeconds
  })).sort((first, second) => first.start - second.start);

  return stabilizeNotes(extractedNotes);
}

function stabilizeNotes(inputNotes) {
  const notes = inputNotes.map(note => ({ ...note }));
  const smoothingWindow = 0.28;
  const maxSmoothedDuration = 0.3;
  const maxGap = 0.2;

  const smoothedNotes = notes.map(note => {
    if (note.duration > maxSmoothedDuration) return note;

    const center = note.start + note.duration / 2;
    const nearbyNotes = notes.filter(candidate => {
      const candidateCenter =
        candidate.start + candidate.duration / 2;

      return (
        Math.abs(candidateCenter - center) <= smoothingWindow &&
        Math.abs(candidate.midi - note.midi) <= 1
      );
    });

    if (nearbyNotes.length < 3) return note;

    const byPitch = nearbyNotes
      .map(candidate => ({
        midi: candidate.midi,
        weight: candidate.duration
      }))
      .sort((first, second) => first.midi - second.midi);
    const halfWeight = byPitch.reduce(
      (total, candidate) => total + candidate.weight,
      0
    ) / 2;
    let accumulatedWeight = 0;

    for (const candidate of byPitch) {
      accumulatedWeight += candidate.weight;
      if (accumulatedWeight >= halfWeight) {
        return { ...note, midi: candidate.midi };
      }
    }

    return note;
  });

  const result = [];

  for (const note of smoothedNotes) {
    const previous = result[result.length - 1];

    if (previous && previous.midi === note.midi) {
      const gap = note.start - (previous.start + previous.duration);

      if (gap <= maxGap) {
        previous.duration = Math.max(
          previous.start + previous.duration,
          note.start + note.duration
        ) - previous.start;
        continue;
      }
    }

    result.push(note);
  }

  return result;
}

// ======================================
// 7. リズムの簡易補正
// ======================================

function quantizeNotes(inputNotes) {

  if (!inputNotes.length) return [];

  const tempoEstimate = estimateTempo(inputNotes);
  tempoBpm = tempoEstimate.bpm;
  tempoEstimateAvailable = tempoEstimate.available;

  const beatSeconds = 60 / tempoBpm;
  const sixteenthSeconds = beatSeconds / 4;

  const result = inputNotes.map((note, index) => {

    const startBeat =
      Math.round(note.start / sixteenthSeconds) / 4;

    const nextNote = inputNotes[index + 1];
    const availableDuration = nextNote
      ? Math.min(note.duration, nextNote.start - note.start)
      : note.duration;
    const durationBeat = closestDuration(
      Math.max(0.05, availableDuration / beatSeconds)
    );

    return {
      ...note,
      startBeat,
      durationBeat
    };
  });

  return result;
}

function estimateTempo(inputNotes) {
  const onsetIntervals = inputNotes.slice(1).map((note, index) =>
    note.start - inputNotes[index].start
  ).filter(interval => interval >= 0.12 && interval <= 3);

  if (onsetIntervals.length < 2) {
    return { bpm: 120, available: false };
  }

  let bestBpm = 120;
  let bestScore = Infinity;

  for (let bpm = 60; bpm <= 180; bpm++) {
    const beatSeconds = 60 / bpm;
    const sixteenthSeconds = beatSeconds / 4;
    const onsetErrors = onsetIntervals.map(interval => {
      const gridSteps = Math.max(
        1,
        Math.round(interval / sixteenthSeconds)
      );
      const error =
        Math.abs(interval - gridSteps * sixteenthSeconds) / beatSeconds;
      const subdivisionPenalty = gridSteps % 4 === 0
        ? 0
        : gridSteps % 2 === 0
          ? 0.04
          : 0.06;

      return error + subdivisionPenalty;
    });

    const durationErrors = inputNotes.map(note => {
      const durationBeats = note.duration / beatSeconds;
      const nearestDuration = closestDuration(durationBeats);
      const durationPenalty =
        [0.75, 1.5, 3].includes(nearestDuration) ? 0.005 : 0;

      return (
        Math.abs(durationBeats - nearestDuration) +
        durationPenalty
      );
    });
    const tempoPrior = Math.abs(Math.log2(bpm / 110)) * 0.015;
    const score =
      median(onsetErrors) * 0.65 +
      median(durationErrors) * 0.35 +
      tempoPrior;

    if (score < bestScore) {
      bestScore = score;
      bestBpm = bpm;
    }
  }

  return { bpm: bestBpm, available: true };
}

function closestDuration(durationBeats) {
  return NOTE_DURATIONS_BEATS.reduce((closest, candidate) =>
    Math.abs(candidate - durationBeats) < Math.abs(closest - durationBeats)
      ? candidate
      : closest
  );
}

// ======================================
// 8. 音声解析ボタン
// ======================================

analyzeBtn.addEventListener("click", async () => {

  if (!audioBlob) return;

  try {

    analysisStatus.textContent = "Basic Pitchモデルを読み込んでいます...";

    analyzeBtn.disabled = true;

    const buffer = await decodeAudio(audioBlob);

    let displayedProgress = -1;
    const extracted = await extractNotes(buffer, progress => {
      const percent = Math.floor(progress * 100);
      if (percent !== displayedProgress) {
        analysisStatus.textContent =
          `Basic Pitchで音声を解析しています... ${percent}%`;
        displayedProgress = percent;
      }
    });

    notes = quantizeNotes(extracted);

    if (notes.length === 0) {
      throw new Error(
        "音程を検出できませんでした。もう少し長く、はっきりと歌ってください。"
      );
    }

    renderNoteList();

    renderSheetMusic();

    midiBtn.disabled = false;
    pdfBtn.disabled = false;

    analysisStatus.textContent = tempoEstimateAvailable
      ? `${notes.length}個の音符を検出しました。推定テンポ: ${tempoBpm} BPM`
      : `${notes.length}個の音符を検出しました。テンポ推定に十分な音符がないため120 BPMで表示しています。`;

  } catch (error) {

    console.error(error);

    analysisStatus.textContent = error.message;

  } finally {

    analyzeBtn.disabled = false;
  }
});

// ======================================
// 12. 音符一覧表示
// ======================================

function renderNoteList() {

  noteList.innerHTML = "";

  notes.forEach(note => {

    const item = document.createElement("div");

    item.className = "note-item";

    item.textContent = midiToName(note.midi);

    noteList.appendChild(item);
  });
}

// ======================================
// 13. MIDI番号をABC記譜法に変換
// ======================================

function midiToABC(midi) {

  const names = [
    "C", "^C", "D", "^D", "E", "F",
    "^F", "G", "^G", "A", "^A", "B"
  ];

  const pitch = midi % 12;

  const octave = Math.floor(midi / 12) - 1;

  let note = names[pitch];

  if (octave >= 5) {
    note = note.toLowerCase();

    for (let i = 5; i < octave; i++) {
      note += "'";
    }
  } else if (octave < 4) {

    for (let i = octave; i < 4; i++) {
      note += ",";
    }
  }

  return note;
}

// ======================================
// 14. 五線譜生成
// ======================================

function renderSheetMusic() {

  let abc = "";

  abc += "X:1\n";
  abc += "T:Humming Score\n";
  abc += "M:4/4\n";
  abc += "L:1/16\n";
  abc += `Q:1/4=${tempoBpm}\n`;
  abc += "K:C\n";

  let currentBeat = 0;

  for (const note of notes) {

    const gap = Math.max(
      0,
      note.startBeat - currentBeat
    );

    if (gap >= 0.25) {
      abc += `z${Math.round(gap * 4)}`;
    }

    const length = Math.max(
      1,
      Math.round(note.durationBeat * 4)
    );

    abc += midiToABC(note.midi) + length;

    currentBeat = Math.max(
      currentBeat,
      note.startBeat + note.durationBeat
    );
  }

  abc += "|\n";

  sheetMusic.innerHTML = "";

  abcjs.renderAbc(
    "sheetMusic",
    abc,
    {
      responsive: "resize",
      staffwidth: 800,
      paddingtop: 15,
      paddingbottom: 15
    }
  );
}

// ======================================
// 15. MIDIファイル出力
// ======================================

midiBtn.addEventListener("click", () => {

  const midi = new Midi();

  midi.name = "Humming Score";

  const track = midi.addTrack();

  track.name = "Melody";

  notes.forEach(note => {

    track.addNote({
      midi: note.midi,
      time: note.startBeat * 60 / tempoBpm,
      duration: note.durationBeat * 60 / tempoBpm,
      velocity: 0.8
    });
  });

  const bytes = midi.toArray();

  const blob = new Blob(
    [bytes],
    { type: "audio/midi" }
  );

  downloadFile(blob, "humming-score.mid");
});

// ======================================
// 16. PDFファイル出力
// ======================================

pdfBtn.addEventListener("click", async () => {

  try {

    const canvas = await html2canvas(
      sheetMusic,
      {
        scale: 2,
        backgroundColor: "#ffffff"
      }
    );

    const image = canvas.toDataURL("image/png");

    const pdf = new jsPDF({
      orientation: "landscape",
      unit: "mm",
      format: "a4"
    });

    const pageWidth = 277;
    const pageHeight = 190;

    const ratio = Math.min(
      pageWidth / canvas.width,
      pageHeight / canvas.height
    );

    const width = canvas.width * ratio;
    const height = canvas.height * ratio;

    pdf.addImage(
      image,
      "PNG",
      10,
      15,
      width,
      height
    );

    pdf.save("humming-score.pdf");

  } catch (error) {

    console.error(error);

    alert("PDF出力に失敗しました。");
  }
});

// ======================================
// 17. ファイルダウンロード
// ======================================

function downloadFile(blob, filename) {

  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");

  link.href = url;
  link.download = filename;

  link.click();

  URL.revokeObjectURL(url);
}

