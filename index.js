window.addEventListener("DOMContentLoaded", () => {
  const recordBtn = document.getElementById("recordButton");
  const statusDisplay = document.getElementById("status");
  const transcriptOutput = document.getElementById("transcriptionText");
  const downloadPdfBtn = document.getElementById("downloadPdfBtn"); // Get the PDF button

  const WEBSOCKET_URL =
    "wss://go-speech-backend-603247174030.us-central1.run.app/ws";

  let socket;
  let mediaRecorder;
  let localStream;
  let isRecording = false;
  let speakerMap = {}; // To map speaker tags (like 1, 2) to labels (Doctor, Patient)
  let nextSpeakerIndex = 0;
  let hasTranscriptContent = false; // Track if there is content

  // --- Ensure jsPDF is loaded ---
  // Doing this check just in case the CDN fails, though usually not needed
  if (typeof window.jspdf === "undefined") {
    console.error("jsPDF library not loaded. PDF download unavailable.");
    downloadPdfBtn.disabled = true;
  }

  function connectWebSocket() {
    statusDisplay.textContent = "Status: Connecting to server...";
    socket = new WebSocket(WEBSOCKET_URL);

    socket.onopen = () => {
      console.log("WebSocket Connected");
      statusDisplay.textContent = "Status: Connected. Ready to record.";
      recordBtn.disabled = false;
    };

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        console.log("Message from server:", message);

        if (message.transcript && message.isFinal) {
          displayTranscript(message.transcript, message.speakerTag);

          if (!hasTranscriptContent) {
            hasTranscriptContent = true;
            downloadPdfBtn.disabled = false;
          }
        }
        // Add handling for interim results if your backend sends them
        // if (message.transcript && !message.isFinal) {
        //    displayInterimTranscript(message.transcript, message.speakerTag);
        // }
      } catch (error) {
        console.error(
          "Failed to parse message or invalid message format:",
          event.data,
          error,
        );
      }
    };

    socket.onerror = (error) => {
      console.error("WebSocket Error:", error);
      statusDisplay.textContent =
        "Status: Connection error. Please check backend.";
      recordBtn.disabled = true;
      isRecording = false; // Ensure state is reset
      cleanupRecording();
    };

    socket.onclose = (event) => {
      console.log("WebSocket Closed:", event.reason);
      statusDisplay.textContent = `Status: Disconnected (${event.reason || "No reason specified"})`;
      recordBtn.disabled = true;
      recordBtn.textContent = "Start Recording";
      recordBtn.classList.remove("recording");
      isRecording = false;
      // Keep PDF button enabled if there's content, disabled if not
      downloadPdfBtn.disabled = !hasTranscriptContent;
      isRecording = false;
      cleanupRecording();
      //try to reconnect?
      setTimeout(connectWebSocket, 5000); // Simple reconnect attempt
    };
  }

  function getSpeakerLabel(tag) {
    if (!(tag in speakerMap)) {
      // Simple assignment: first speaker is Doctor, second is Patient
      // A more robust app might let the user assign these.
      speakerMap[tag] = nextSpeakerIndex === 0 ? "speakerA" : `speakerB`;
      // speakerMap[tag] = `Speaker ${tag}`; // Generic fallback
      nextSpeakerIndex++;
    }
    return speakerMap[tag];
  }

  function displayTranscript(text, speakerTag) {
    const speakerLabel = getSpeakerLabel(speakerTag);
    const line = document.createElement("div");
    line.classList.add("transcript-line");

    const speakerSpan = document.createElement("span");
    speakerSpan.classList.add("speaker-label", `speaker-${speakerLabel}`); // Add specific class
    speakerSpan.textContent = `${speakerLabel}:`;

    const textNode = document.createTextNode(` ${text}`); // Add space after label

    line.appendChild(speakerSpan);
    line.appendChild(textNode);

    transcriptOutput.appendChild(line);
    // Auto-scroll to the bottom
    transcriptOutput.scrollTop = transcriptOutput.scrollHeight;
  }

  async function startRecording() {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      statusDisplay.textContent = "Status: Not connected to server.";
      return;
    }
    if (isRecording) return;

    statusDisplay.textContent = "Status: Requesting mic permission...";
    speakerMap = {}; // Reset speaker mapping for new session
    nextSpeakerIndex = 0;
    // transcriptOutput.innerHTML = ''; // Clear previous transcript

    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
      statusDisplay.textContent = "Status: Mic access granted. Starting...";

      // --- Important: Check Sample Rate and Encoding ---
      // The backend (and Google Cloud) needs to know the exact sample rate.
      // Browsers often default to 48000 or 44100. We need to tell the backend.
      // MediaRecorder doesn't easily expose this *before* recording.
      // For simplicity, we'll assume a common rate (e.g., 48000) and configure
      // the backend accordingly. A more robust solution might involve an
      // AudioContext to analyze the sample rate first.
      const audioContext = new AudioContext();
      const sampleRate = audioContext.sampleRate;
      console.log(`Audio Sample Rate: ${sampleRate}`);
      // Send sample rate info to backend when connection opens or recording starts
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "config", sampleRate: sampleRate }));
      }
      await audioContext.close(); // Close context after getting rate

      mediaRecorder = new MediaRecorder(localStream, {
        // mimeType: 'audio/webm;codecs=opus' // Common, good quality/compression
        // mimeType: 'audio/wav' // Less common in MediaRecorder, large files
        // Let the browser choose default, backend needs to handle it (or request specific)
      });

      mediaRecorder.ondataavailable = (event) => {
        if (
          event.data.size > 0 &&
          socket &&
          socket.readyState === WebSocket.OPEN
        ) {
          // Send buffer directly. Backend needs to handle ArrayBuffer/Blob.
          socket.send(event.data);
        }
      };

      mediaRecorder.onstart = () => {
        isRecording = true;
        statusDisplay.textContent = "Status: Recording...";
        recordBtn.textContent = "Stop Recording";
        recordBtn.classList.add("recording");
        console.log("MediaRecorder started");
      };

      mediaRecorder.onstop = () => {
        console.log("MediaRecorder stopped");
        // No need to explicitly set isRecording = false here,
        // it's handled by the button click or socket close.
      };

      mediaRecorder.onerror = (event) => {
        console.error("MediaRecorder Error:", event.error);
        statusDisplay.textContent = `Status: Recording Error - ${event.error.name}`;
        stopRecording(); // Stop on error
      };

      // How often to chunk the audio (milliseconds)
      // Smaller values = lower latency, more network traffic
      // Larger values = higher latency, less network traffic
      const timeSlice = 500; // 500ms chunks
      mediaRecorder.start(timeSlice);
    } catch (err) {
      console.error("Error starting recording:", err);
      statusDisplay.textContent = `Status: Error - ${err.message}`;
      if (err.name === "NotAllowedError") {
        statusDisplay.textContent = "Status: Microphone permission denied.";
      }
      cleanupRecording();
    }
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop(); // This triggers ondataavailable one last time, then onstop
    }
    // Send a specific "end" signal if your backend protocol requires it
    // if (socket && socket.readyState === WebSocket.OPEN) {
    //    socket.send(JSON.stringify({ type: 'endStream' }));
    // }

    cleanupRecording(); // Release mic
    isRecording = false;
    statusDisplay.textContent = "Status: Recording stopped. Ready.";
    recordBtn.textContent = "Start Recording";
    recordBtn.classList.remove("recording");

    downloadPdfBtn.disabled = !hasTranscriptContent;
  }

  function cleanupRecording() {
    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
      localStream = null;
      console.log("Microphone stream stopped.");
    }
    mediaRecorder = null; // Allow garbage collection
  }

  // --- PDF Generation Logic ---
  function generatePdf() {
    if (!hasTranscriptContent || typeof window.jspdf === "undefined") {
      console.warn("No transcript content or jsPDF not loaded.");
      return;
    }

    // Get the jsPDF object
    const { jsPDF } = window.jspdf;

    // Create a new PDF document (portrait, millimeters, A4 size)
    const doc = new jsPDF();

    // --- Configuration ---
    const pageHeight = doc.internal.pageSize.height;
    const pageWidth = doc.internal.pageSize.width;
    const margin = 15; // mm
    const effectiveWidth = pageWidth - 2 * margin;
    const lineHeight = 7; // mm (adjust based on font size)
    const startY = margin;
    let currentY = startY;

    // --- Add a Title ---
    doc.setFontSize(16);
    doc.text("Conversation Transcript", pageWidth / 2, currentY, {
      align: "center",
    });
    currentY += lineHeight * 2; // Add some space after title

    // --- Process Transcript Lines ---
    doc.setFontSize(10); // Set font size for transcript content
    const lines = transcriptOutput.querySelectorAll(".transcript-line");

    lines.forEach((lineElement) => {
      // Get text content from the line, preserving structure roughly
      // innerText tries to approximate rendered text, which is good here
      const lineText = lineElement.innerText || lineElement.textContent;

      // Split the text into lines that fit the page width
      const splitLines = doc.splitTextToSize(lineText, effectiveWidth);

      splitLines.forEach((textLine) => {
        // Check if we need a new page
        if (currentY + lineHeight > pageHeight - margin) {
          doc.addPage();
          currentY = startY; // Reset Y position to top margin
        }
        // Add the text line to the PDF
        doc.text(textLine, margin, currentY);
        currentY += lineHeight; // Move down for the next line
      });
    });

    // --- Save the PDF ---
    try {
      doc.save("conversation_transcript.pdf");
    } catch (e) {
      console.error("Error saving PDF: ", e);
      alert("Could not generate or save the PDF.");
    }
  }

  // --- Button Control ---
  recordBtn.onclick = () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording(); // Will check socket connection inside
    }
  };

  // Add listener for the PDF button
  downloadPdfBtn.onclick = generatePdf;

  // --- Initial Connection ---
  recordBtn.disabled = true; // Disable button until connected
  connectWebSocket();
}); // End DOMContentLoaded
