/**
 * VoiceAssistant.js
 * 
 * Clase principal para el asistente de voz legal con integración de OpenAI Realtime.
 * Maneja la interacción de voz, reconocimiento de habla, síntesis de voz y 
 * comunicación con el backend Flask.
 * 
 * Funcionalidades principales:
 * - Reconocimiento de voz con Web Speech API
 * - Síntesis de voz con SpeechSynthesis
 * - Comunicación en tiempo real con Socket.IO
 * - Integración con OpenAI Realtime API
 * - Interfaz de usuario para conversaciones legales
 * - Persistencia de conversaciones
 * 
 * Requiere: Socket.IO cliente, Web Speech API soportado por el navegador
 */

class VoiceAssistant {
  /**
   * Inicializa el asistente de voz con todos los componentes necesarios
   */
  constructor() {
    // Elementos del DOM
    this.chatArea = document.getElementById('chatArea');
    this.startBtn = document.getElementById('startBtn');
    this.stopBtn = document.getElementById('stopBtn');
    this.saveBtn = document.getElementById('saveBtn');
    this.realtimeBtn = document.getElementById('realtimeBtn');
    this.status = document.getElementById('status');

    // Estado de la aplicación
    this.conversationId = null;
    this.listening = false;
    this.recording = false;
    this.conversationActive = false;

    // Componentes de voz
    this.recognition = null;
    this.audioContext = null;
    this.mediaRecorder = null;
    this.recognitionStarting = false;
    this.isSpeaking = false;
    // Audio level monitoring (to prefer the nearest/loudest speaker)
    this._levelMonitor = null; // { audioContext, source, analyser, dataArray, rafId }
    this._lastLevel = null; // smoothed level 0..1 (null when monitor inactive)
    this.levelThreshold = 0.005; // very low default threshold to avoid false negatives
    this.levelSmoothing = 0.85; // smoothing factor for level
    // Temporary stream/audio context used only for listening-level monitoring when recognition starts
    this._listenLevelStream = null;
    this._listenAudioContext = null;
    // Guardas para evitar start() duplicados y reintentos controlados
    this._startListenAttempts = 0;
    this._maxStartListenAttempts = 6;
    // Reconocimiento: retries y watchdog
    this.retryCount = 0;
    this.maxRetries = 1; // Reducir reintentos automáticos
    this.listenWatchdogTimeout = 15000; // 15s para dar más tiempo
    this._listenWatchdogId = null;
    this._accumulatedInterim = '';
    this._lastHadFinal = false;

    // Conexión en tiempo real
    this.socket = null;

    // Inicializar componentes
    this.init();
  }

  /** Actualiza la UI del medidor de nivel si está presente */
  _updateLevelUI() {
    try {
      const fill = document.getElementById('levelMeterFill');
      const val = document.getElementById('levelMeterValue');
      if (!fill || !val) return;
      // Si el texto es la pregunta de historial legal, activar timer especial
      if (typeof text === 'string' && text.trim().toLowerCase().includes('cuéntame tu historial legal')) {
        if (this._historialLegalTimeoutId) clearTimeout(this._historialLegalTimeoutId);
        this._historialLegalTimeoutId = setTimeout(() => {
          // Si no hubo respuesta final en 10s, preguntar si quiere agregar algo más
          if (this.conversationActive && !this.isSpeaking && this.listening) {
            this.addMessage('assistant', '¿Quieres agregar algo más a tu historial legal?');
            this.speak('¿Quieres agregar algo más a tu historial legal?');
          }
        }, 10000);
        console.log('Timer de historial legal activado (10s)');
      }
      const pct = Math.min(1, Math.max(0, this._lastLevel || 0));
      fill.style.width = `${Math.round(pct * 100)}%`;
      val.textContent = (this._lastLevel || 0).toFixed(3);
    } catch (e) { /* silent */ }
  }

  /** Calibra automáticamente el umbral tomando mediciones durante 3 segundos */
  async calibrateLevel() {
    if (!this._levelMonitor) {
      // Intentar iniciar monitor temporal si no existe
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const ac = this.audioContext || new (window.AudioContext || window.webkitAudioContext)();
        this._startLevelMonitor(ac, stream);
        // Detener el stream después de calibrar
        setTimeout(() => {
          try { stream.getTracks().forEach(t => t.stop()); } catch (e) { }
        }, 3500);
      } catch (e) {
        console.warn('No se pudo acceder al micrófono para calibrar:', e);
        this.showSystemMessage('No se pudo acceder al micrófono para calibrar. Asegura permisos.');
        return;
      }
    }

    this.showSystemMessage('Calibrando umbral de nivel durante 3 segundos...');
    const samples = [];
    const sampleInterval = 150; // ms
    const rounds = Math.floor(3000 / sampleInterval);
    for (let i = 0; i < rounds; i++) {
      samples.push(this._lastLevel || 0);
      await new Promise(r => setTimeout(r, sampleInterval));
    }

    // calcular percentil 70 para evitar picos
    samples.sort((a, b) => a - b);
    const idx = Math.min(samples.length - 1, Math.floor(samples.length * 0.7));
    const suggested = samples[idx] * 0.85; // margen por seguridad
    if (suggested && isFinite(suggested)) {
      this.levelThreshold = Math.max(0.01, Math.min(0.2, suggested));
      // reflejar en UI
      const slider = document.getElementById('levelThreshold');
      const out = document.getElementById('levelThresholdValue');
      if (slider) slider.value = this.levelThreshold;
      if (out) out.value = this.levelThreshold.toFixed(3);
      this.showSystemMessage(`Calibración completa. Umbral sugerido: ${this.levelThreshold.toFixed(3)}`);
    } else {
      this.showSystemMessage('No se pudo determinar umbral durante la calibración. Intenta de nuevo.');
    }
  }

  /**
   * Inicializa todos los componentes del asistente
   */
  init() {
    // Inicializar reconocimiento de voz
    this.initSpeechRecognition();

    // Inicializar síntesis de voz
    this.initSpeechSynthesis();

    // Inicializar conexión en tiempo real
    this.initSocketIO();

    // Vincular eventos a los botones
    this.bindEvents();

    // Verificar soporte del navegador
    this.checkBrowserSupport();
  }

  /**
   * Inicializa el reconocimiento de voz utilizando Web Speech API
   */
  initSpeechRecognition() {
    // Verificar soporte del navegador para reconocimiento de voz
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      this.showSystemMessage('Tu navegador no soporta reconocimiento de voz. Por favor, usa Chrome o Edge.');
      console.warn('Speech recognition not supported');
      return;
    }

    // Crear instancia de reconocimiento de voz
    this.recognition = new SpeechRecognition();
    // Permitir resultados interinos y escucha continua para capturar frases largas
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = 'es-CO'; // Configurar para español de Colombia

    // Manejar resultados del reconocimiento (interim + final)
    this.recognition.onresult = (event) => {
      // Reiniciar watchdog: hay actividad de audio
      this._clearWatchdog();

      // Si estamos monitoreando niveles y el nivel actual es bajo, ignorar interinos para favorecer la voz más cercana
      if (this._lastLevel !== null && this._lastLevel < this.levelThreshold) {
        console.log('Nivel de audio bajo (', this._lastLevel.toFixed(3), '), ignorando resultados interinos/temporales');
        // Si el resultado es final y aun así muy bajo, podemos descartarlo
        // No devolvemos nada aquí
      }

      let interim = '';
      let finalTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const text = res[0].transcript.trim();
        if (res.isFinal) {
          finalTranscript += text + ' ';
        } else {
          interim += text + ' ';
        }
      }

      if (interim) {
        this._accumulatedInterim = interim.trim();
        console.log('Interim:', this._accumulatedInterim);
        // Esperar un poco más por si vienen más interinos
        this._listenWatchdogId = setTimeout(() => {
          console.log('Watchdog tras interinos expiró, forzando stop');
          try { this.recognition.stop(); } catch (e) { }
        }, 1500);
      }

      if (finalTranscript) {
        this._accumulatedInterim = '';
        const userMessage = finalTranscript.trim();
        console.log('Final recognized:', userMessage);
        this._lastHadFinal = true;
        // Debug: mostrar información del nivel
        console.log('Final transcript check - Level:', this._lastLevel, 'Threshold:', this.levelThreshold, 'Monitor active:', this._levelMonitor !== null);

        // Procesar resultado final siempre por ahora (para debugging)
        // TODO: Restaurar filtro de nivel cuando funcione correctamente
        this.handleUserFinalTranscript(userMessage);

        /* Filtro de nivel temporalmente deshabilitado para debugging
        if (this._lastLevel !== null && this._lastLevel < this.levelThreshold) {
          console.log('Descartando final reconocido porque el nivel es bajo:', this._lastLevel);
        } else {
          this.handleUserFinalTranscript(userMessage);
        }
        */
      }
    };

    // Manejar errores de reconocimiento
    this.recognition.onerror = (event) => {
      console.error('Error en reconocimiento de voz:', event.error);

      // Determinar mensaje de error apropiado
      let errorMessage = 'Error en reconocimiento de voz.';
      switch (event.error) {
        case 'no-speech':
          errorMessage = 'No se detectó voz. Por favor, habla más fuerte.';
          break;
        case 'audio-capture':
          errorMessage = 'No se pudo acceder al micrófono. Verifica los permisos.';
          break;
        case 'not-allowed':
          errorMessage = 'Permiso de micrófono denegado. Por favor, permite el acceso.';
          break;
        default:
          errorMessage = 'Error en reconocimiento de voz. Por favor, intenta de nuevo.';
      }

      this.showSystemMessage(errorMessage);
      // Asegurar que la bandera de inicio se reinicie
      this.recognitionStarting = false;
      this._clearWatchdog();
      // No detener inmediatamente aquí: onend gestionará reintentos y lógica
    };

    // Manejar finalización del reconocimiento
    this.recognition.onend = () => {
      // Marcar que ya no está escuchando cuando termine
      this.listening = false;
      this.recognitionStarting = false;
      // reset attempts cuando termina el ciclo
      this._startListenAttempts = 0;
      this._clearWatchdog();

      console.log('Recognition ended. isSpeaking:', this.isSpeaking, 'hadFinal:', this._lastHadFinal, 'retryCount:', this.retryCount);

      // NO reintentar si el asistente está hablando
      if (this.isSpeaking) {
        console.log('Asistente hablando, no reintentar reconocimiento');
        this.retryCount = 0; // Reset reintentos
        this._lastHadFinal = false;
        return;
      }

      // Si no hubo resultado final, intentar reintentos suaves (pero limitados)
      if (!this._lastHadFinal) {
        if (this.retryCount < this.maxRetries && !this.isSpeaking && this.conversationActive) {
          this.retryCount++;
          const backoff = 800 * this.retryCount; // Más tiempo entre reintentos
          console.log(`Reintentando escucha (#${this.retryCount}) en ${backoff}ms`);
          setTimeout(() => {
            if (!this.isSpeaking && this.conversationActive) { // Double check
              this.startListening();
            }
          }, backoff);
        } else {
          // Agotar reintentos: notificar y resetear contador
          this.retryCount = 0;
          if (this.conversationActive) {
            this.addMessage('system', 'No he logrado escucharte. Por favor, habla con calma y proporciona la información en un solo turno.');
          }
        }
      }

      // Reset bandera auxiliar
      this._lastHadFinal = false;
    };

    // Manejar inicio del reconocimiento
    this.recognition.onstart = () => {
      // Marcar que la escucha realmente inició
      this.listening = true;
      this.recognitionStarting = false;
      // reset attempts cuando realmente inicia
      this._startListenAttempts = 0;
      this.updateStatus('Escuchando...', 'blue');
      this.addMessage('system', 'Escuchando...');
      // reset retries al iniciar con éxito
      this.retryCount = 0;
      // inicializar watchdog: si no hay actividad en listenWatchdogTimeout, se considerará sin-voz
      this._listenWatchdogId = setTimeout(() => {
        console.log('Watchdog expiró: no se detectó voz a tiempo');
        try { this.recognition.stop(); } catch (e) { }
      }, this.listenWatchdogTimeout);
    };
  }

  /**
   * Inicializa la síntesis de voz para que el asistente pueda hablar
   */
  initSpeechSynthesis() {
    // Verificar soporte de síntesis de voz
    if (!window.speechSynthesis) {
      this.showSystemMessage('Tu navegador no soporta síntesis de voz.');
      console.warn('Speech synthesis not supported');
      return;
    }

    // Obtener voces disponibles
    this.voices = [];
    this.loadVoices();

    // Recargar voces si cambian
    window.speechSynthesis.onvoiceschanged = () => {
      this.loadVoices();
    };
  }

  /**
   * Carga las voces disponibles en el sistema
   */
  loadVoices() {
    this.voices = window.speechSynthesis.getVoices();
    console.log('Voces disponibles:', this.voices.length);

    // Buscar voz en español con más opciones
    const spanishVoices = this.voices.filter(voice =>
      voice.lang.includes('es') ||
      voice.name.toLowerCase().includes('espa') ||
      voice.name.toLowerCase().includes('spanish') ||
      voice.name.toLowerCase().includes('mónica') ||
      voice.name.toLowerCase().includes('montse')
    );

    console.log('Voces en español encontradas:', spanishVoices.map(v => `${v.name} (${v.lang})`));

    // Preferir voces de España o México, luego cualquier español
    this.spanishVoice = spanishVoices.find(v => v.lang.includes('es-ES')) ||
      spanishVoices.find(v => v.lang.includes('es-MX')) ||
      spanishVoices.find(v => v.lang.includes('es-')) ||
      spanishVoices[0] ||
      null;

    if (this.spanishVoice) {
      console.log('Voz española seleccionada:', this.spanishVoice.name, '(' + this.spanishVoice.lang + ')');
    } else {
      console.warn('No se encontró voz en español, usando voz por defecto del sistema');
    }
  }

  /**
   * Inicializa la conexión Socket.IO para comunicación en tiempo real
   */
  initSocketIO() {
    try {
      // Crear conexión Socket.IO
      this.socket = io({
        path: '/socket.io',
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
        timeout: 20000,
        transports: ['websocket', 'polling']
      });

      // Manejar conexión exitosa
      this.socket.on('connect', () => {
        console.log('Conectado al servidor');
        this.updateStatus('Conectado al servidor', 'green');
      });

      // Manejar desconexión
      this.socket.on('disconnect', (reason) => {
        console.log('Desconectado del servidor:', reason);
        this.updateStatus('Desconectado del servidor', 'red');

        // Si la desconexión es inesperada, intentar reconectar
        if (reason !== 'io client disconnect') {
          this.showSystemMessage('Conexión perdida. Intentando reconectar...');
        }
      });

      // Manejar errores de conexión
      this.socket.on('connect_error', (error) => {
        console.error('Error de conexión:', error);
        this.updateStatus('Error de conexión', 'red');
        this.showSystemMessage('Error al conectar con el servidor.');
      });

      // Manejar conexión con OpenAI Realtime
      this.socket.on('openai_connected', (data) => {
        console.log('Conectado a OpenAI Realtime', data);
        this.updateStatus('Conectado a OpenAI Realtime', 'green');
        this.realtimeBtn.disabled = true;
        this.showSystemMessage('Modo OpenAI Realtime activado. Habla directamente con el asistente.');
      });

      // Manejar respuesta de OpenAI
      this.socket.on('openai_response', (data) => {
        console.log('Respuesta de OpenAI:', data);
        this.addMessage('assistant', data.text);
        this.speak(data.text);
      });

      // Manejar errores del servidor
      this.socket.on('error', (data) => {
        console.error('Error del servidor:', data);
        this.showSystemMessage(`Error: ${data.message}`);
      });

    } catch (error) {
      console.error('Error inicializando Socket.IO:', error);
      this.showSystemMessage('No se pudo establecer conexión en tiempo real.');
    }
  }

  /**
   * Vincula eventos a los botones de la interfaz
   */
  bindEvents() {
    // Iniciar conversación
    this.startBtn.addEventListener('click', () => this.startConversation());

    // Detener conversación
    this.stopBtn.addEventListener('click', () => this.stopConversation());

    // Guardar conversación manualmente
    this.saveBtn.addEventListener('click', () => this.saveConversation());

    // Conectar con OpenAI Realtime
    this.realtimeBtn.addEventListener('click', () => this.connectOpenAIRealtime());

    // Manejar eventos del teclado
    document.addEventListener('keydown', (event) => {
      // Ctrl+Enter para iniciar conversación
      if (event.ctrlKey && event.key === 'Enter') {
        event.preventDefault();
        if (this.startBtn && !this.startBtn.disabled) {
          this.startBtn.click();
        }
      }

      // Ctrl+M para detener
      if (event.ctrlKey && event.key === 'm') {
        event.preventDefault();
        if (this.stopBtn && !this.stopBtn.disabled) {
          this.stopBtn.click();
        }
      }
    });
  }

  /**
   * Verifica el soporte del navegador para las APIs necesarias
   */
  checkBrowserSupport() {
    let missingFeatures = [];

    // Verificar reconocimiento de voz
    if (!window.SpeechRecognition && !window.webkitSpeechRecognition) {
      missingFeatures.push('reconocimiento de voz');
    }

    // Verificar síntesis de voz
    if (!window.speechSynthesis) {
      missingFeatures.push('síntesis de voz');
    }

    // Verificar grabación de medios
    if (!window.MediaRecorder) {
      missingFeatures.push('grabación de audio');
    }

    // Verificar promesas (para async/await)
    if (typeof Promise === 'undefined') {
      missingFeatures.push('promesas');
    }

    // Mostrar advertencias si faltan características
    if (missingFeatures.length > 0) {
      const features = missingFeatures.join(', ');
      this.showSystemMessage(`Algunas funciones pueden no estar disponibles: ${features}`);
      console.warn(`Funciones faltantes: ${features}`);
    }
  }

  /**
   * Inicia una nueva conversación con el asistente legal
   */
  async startConversation() {
    try {
      // Deshabilitar botón de inicio
      this.startBtn.disabled = true;
      this.updateStatus('Iniciando conversación...', 'orange');

      // Enviar solicitud al servidor para iniciar conversación
      const response = await fetch('/api/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        }
      });

      // Verificar respuesta
      if (!response.ok) {
        throw new Error(`Error HTTP: ${response.status}`);
      }

      // Obtener datos de respuesta
      const data = await response.json();

      if (data.error) {
        throw new Error(data.error);
      }

      // Almacenar ID de conversación
      this.conversationId = data.conversation_id;

      // Mostrar mensaje inicial del asistente
      this.addMessage('assistant', data.message);
      this.speak(data.message);

      // Habilitar botones de control
      this.conversationActive = true;
      this.stopBtn.disabled = false;
      this.saveBtn.disabled = false;
      this.realtimeBtn.disabled = false;

      // Iniciar escucha sólo si no se está hablando y no estamos en realtime
      if (!this.isSpeaking && !this.recording) {
        this.startListening();
      }

      // Actualizar estado
      this.updateStatus('Conversación activa', 'green');
      this.showSystemMessage('Conversación iniciada. Por favor, responde las preguntas.');

      console.log(`Conversación iniciada: ${this.conversationId}`);

    } catch (error) {
      console.error('Error iniciando conversación:', error);
      this.updateStatus('Error', 'red');
      this.showSystemMessage(`Error al iniciar la conversación: ${error.message}`);

      // Rehabilitar botón de inicio
      this.startBtn.disabled = false;
    }
  }

  /**
   * Detiene la conversación actual
   */
  stopConversation() {
    this.stopListening();
    this.stopRecording();

    // Actualizar estado de la interfaz
    this.conversationActive = false;
    this.startBtn.disabled = false;
    this.stopBtn.disabled = true;
    this.saveBtn.disabled = true;
    this.realtimeBtn.disabled = true;

    // Actualizar estado
    this.updateStatus('Conversación finalizada', 'red');
    this.showSystemMessage('Conversación finalizada.');

    // Guardar automáticamente al detener la conversación si hay una activa
    if (this.conversationId) {
      try {
        this.saveConversation();
      } catch (e) { console.warn('Error al guardar automáticamente:', e); }
    }

    console.log('Conversación detenida');
  }

  /**
   * Inicia la escucha de voz del usuario
   */
  async startListening() {
    if (!this.recognition) {
      this.showSystemMessage('Reconocimiento de voz no disponible.');
      return;
    }

    // Evitar iniciar si ya estamos escuchando o si estamos hablando
    if (this.listening || this.recognitionStarting || this.isSpeaking) {
      console.warn('startListening: ya está escuchando, en proceso de inicio o el sistema está hablando');
      return;
    }

    // Intentos limitados para evitar loops infinitos
    if (this._startListenAttempts >= this._maxStartListenAttempts) {
      console.warn('startListening: se alcanzó el máximo de intentos de inicio');
      this._startListenAttempts = 0;
      return;
    }

    try {
      this._startListenAttempts++;
      this.recognitionStarting = true;

      // Intentar iniciar un pequeño stream de audio para el monitor de nivel
      // Esto mejora la probabilidad de tener un _lastLevel válido al recibir resultados
      try {
        if (!this._levelMonitor && !this._listenLevelStream) {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              channelCount: 1,
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true
            }
          });

          // Crear un AudioContext local para el monitor (no reemplaza this.audioContext usado por recording)
          try {
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            this._listenAudioContext = audioCtx;
            this._listenLevelStream = stream;
            try {
              this._startLevelMonitor(audioCtx, stream);
            } catch (e) {
              console.warn('No se pudo iniciar el level monitor en startListening():', e);
            }
          } catch (e) {
            console.warn('No se pudo crear AudioContext para level monitor:', e);
            // Aun así guardamos el stream para poder cerrarlo luego
            this._listenLevelStream = stream;
          }
        }
      } catch (e) {
        // No bloquear el inicio del reconocimiento si getUserMedia falla
        console.warn('getUserMedia para level monitor falló (no crítico):', e);
      }

      // Finalmente iniciar el reconocimiento de voz
      this.recognition.start();
      console.log('Iniciado proceso de reconocimiento (start() llamado), intento', this._startListenAttempts);
      // this.listening se marcará en recognition.onstart
    } catch (error) {
      console.error('Error al iniciar reconocimiento:', error);
      // Manejar caso específico de InvalidStateError: reconocer que ya se inició y reintentar suavemente
      if (error && error.name === 'InvalidStateError') {
        console.warn('recognition.start() lanzó InvalidStateError — probablemente ya está iniciando. Reintentando en 200ms');
        // asegurar flags coherentes
        this.recognitionStarting = false;
        // pequeño reintento asíncrono
        setTimeout(() => {
          this.startListening();
        }, 200 + (this._startListenAttempts * 50));
        return;
      }

      this.showSystemMessage('Error al iniciar la escucha.');
      // Asegurar estado consistente
      this.listening = false;
      this.recognitionStarting = false;
    }
  }

  /**
   * Detiene la escucha de voz
   */
  stopListening() {
    if (!this.recognition) return;

    if (!this.listening) {
      // No hay nada que detener
      return;
    }

    try {
      this.recognition.stop();
      // this.listening se actualizará en recognition.onend
      console.log('Escucha detenida');
    } catch (error) {
      console.error('Error al detener reconocimiento:', error);
      // Forzar estado seguro
      this.listening = false;
    }

    // Limpiar cualquier stream/AudioContext creado solamente para el monitor de escucha
    try {
      if (this._levelMonitor) {
        try { this._stopLevelMonitor(); } catch (e) { console.warn('Error al detener level monitor', e); }
      }

      if (this._listenLevelStream) {
        try {
          this._listenLevelStream.getTracks().forEach(t => t.stop());
        } catch (e) { console.warn('Error deteniendo tracks de listenLevelStream', e); }
        this._listenLevelStream = null;
      }

      if (this._listenAudioContext && this._listenAudioContext.state !== 'closed') {
        try { this._listenAudioContext.close(); } catch (e) { console.warn('Error cerrando listenAudioContext', e); }
        this._listenAudioContext = null;
      }
    } catch (e) {
      console.warn('Error limpiando recursos de monitor de nivel en stopListening()', e);
    }
  }

  /**
   * Limpia el watchdog de escucha si existe
   */
  _clearWatchdog() {
    if (this._listenWatchdogId) {
      clearTimeout(this._listenWatchdogId);
      this._listenWatchdogId = null;
    }
  }

  /**
   * Procesa el transcript final reconocido por el usuario
   */
  handleUserFinalTranscript(userMessage) {
    // Si hay un timer de historial legal activo, cancelarlo al recibir respuesta
    if (this._historialLegalTimeoutId) {
      clearTimeout(this._historialLegalTimeoutId);
      this._historialLegalTimeoutId = null;
      console.log('Timer de historial legal cancelado por respuesta del usuario');
    }
    // Añadir el mensaje del usuario al chat y enviarlo al servidor
    this.addMessage('user', userMessage);
    // Reset flags y retries
    this.retryCount = 0;
    this._lastHadFinal = true;
    // Enviar al servidor para procesamiento
    this.sendToServer(userMessage);
    // Si no estamos en realtime y la conversación sigue activa, iniciar nuevo ciclo de escucha
    if (!this.recording && this.conversationActive && !this.isSpeaking) {
      // Mantener escucha abierta si es necesario (recognition.continuous=true)
      // no llamar startListening() aquí para evitar reentradas; onend/manage cycles controlará
    }
  }

  /**
   * Maneja un mensaje del usuario
   * @param {string} message - Mensaje del usuario
   */
  async handleUserMessage(message) {
    // Mostrar mensaje del usuario
    this.addMessage('user', message);

    // Enviar al servidor para procesamiento
    await this.sendToServer(message);

    // Si no estamos en modo OpenAI Realtime y no se está hablando, continuar con la escucha
    if (!this.recording && !this.isSpeaking) {
      this.startListening();
    }
  }

  /**
   * Envía un mensaje al servidor para procesamiento
   * @param {string} userMessage - Mensaje del usuario
   */
  async sendToServer(userMessage) {
    if (!this.conversationId) {
      this.showSystemMessage('No hay conversación activa.');
      return;
    }

    try {
      const response = await fetch('/api/message', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          conversation_id: this.conversationId,
          message: userMessage
        })
      });

      if (!response.ok) {
        throw new Error(`Error HTTP: ${response.status}`);
      }

      const data = await response.json();

      if (data.error) {
        throw new Error(data.error);
      }

      // Mostrar mensaje del asistente
      this.addMessage('assistant', data.message);

      // Hablar la respuesta
      this.speak(data.message);

      // Si la conversación está completa
      if (data.conversation_complete) {
        this.completeConversation();
      }

    } catch (error) {
      console.error('Error enviando mensaje:', error);
      this.showSystemMessage('Error al procesar la respuesta. Por favor, intenta de nuevo.');
    }
  }

  /**
   * Completa la conversación y la guarda
   */
  completeConversation() {
    this.stopListening();
    this.stopRecording();

    // Actualizar estado de la interfaz
    this.conversationActive = false;
    this.startBtn.disabled = false;
    this.stopBtn.disabled = true;
    this.saveBtn.disabled = true;
    this.realtimeBtn.disabled = true;

    // Actualizar estado
    this.updateStatus('Conversación completada', 'green');
    this.showSystemMessage('Conversación finalizada. Gracias por usar el asistente legal.');

    console.log('Conversación completada');
  }

  /**
   * Conecta con la API en tiempo real de OpenAI
   */
  async connectOpenAIRealtime() {
    this.updateStatus('Conectando con OpenAI Realtime...', 'orange');
    this.showSystemMessage('Conectando con OpenAI Realtime...');

    try {
      // Solicitar acceso al micrófono
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 24000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      // Inicializar AudioContext
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 24000
      });

      // Iniciar monitor de nivel para priorizar la voz más cercana
      try {
        this._startLevelMonitor(this.audioContext, stream);
      } catch (e) {
        console.warn('No se pudo iniciar level monitor:', e);
      }

      // Crear MediaRecorder para grabar audio
      this.mediaRecorder = new MediaRecorder(stream);

      // Manejar datos de audio disponibles
      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0 && this.recording) {
          // Si hay monitor de nivel y el nivel es bajo, no enviamos el chunk
          if (this._lastLevel !== null && this._lastLevel < this.levelThreshold) {
            console.log('Omitiendo envío de audio por nivel bajo:', this._lastLevel);
            return;
          }
          this.sendAudioToOpenAI(event.data);
        }
      };

      // Manejar finalización de grabación
      this.mediaRecorder.onstop = () => {
        this.recording = false;
        this.updateStatus('Grabación detenida', 'red');
      };

      // Iniciar grabación con intervalos de 250ms para baja latencia
      this.mediaRecorder.start(250);
      this.recording = true;

      // Indicador visual de grabación continua
      try { document.body.classList.add('recording'); } catch (e) { }
      this.updateStatus('Grabando (modo voz continuo)', 'red');
      this.showSystemMessage('Modo voz continuo activado. Pulsa "Detener" cuando quieras finalizar la grabación.');

      // Conectar con OpenAI Realtime a través del servidor
      this.socket.emit('openai_connect', {
        conversation_id: this.conversationId
      });

      // Actualizar interfaz
      this.updateStatus('Conectado a OpenAI Realtime', 'green');

    } catch (error) {
      console.error('Error conectando con OpenAI Realtime:', error);

      // Determinar mensaje de error apropiado
      let errorMessage = 'Error al conectar con OpenAI Realtime.';
      if (error.name === 'NotAllowedError') {
        errorMessage = 'Permiso de micrófono denegado. Por favor, permite el acceso para usar OpenAI Realtime.';
      } else if (error.name === 'NotFoundError') {
        errorMessage = 'No se encontró dispositivo de audio. Verifica tu micrófono.';
      }

      this.updateStatus('Error de conexión', 'red');
      this.showSystemMessage(errorMessage);
    }
  }

  /**
* Detiene la grabación de audio
*/
  stopRecording() {
    if (this.mediaRecorder && this.recording) {
      this.mediaRecorder.stop();
      this.recording = false;
      console.log('Grabación detenida');
    }

    // Quitar indicador visual de grabación
    try { document.body.classList.remove('recording'); } catch (e) { }

    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
      console.log('AudioContext cerrado');
      // Parar monitor de nivel si estaba activo
      try { this._stopLevelMonitor(); } catch (e) { console.warn('Error deteniendo level monitor', e); }
    }
  }

  /**
   * Envía datos de audio a OpenAI Realtime a través del servidor
   * @param {Blob} audioBlob - Datos de audio en formato Blob
   */
  sendAudioToOpenAI(audioBlob) {
    // Convertir Blob a base64
    const reader = new FileReader();
    reader.onload = () => {
      const base64data = reader.result.split(',')[1];

      // Enviar datos de audio al servidor
      this.socket.emit('audio_data', {
        audio: base64data,
        conversation_id: this.conversationId,
        format: 'webm',
        sample_rate: 24000
      });
    };
    reader.readAsDataURL(audioBlob);
  }

  /**
   * Inicia un monitor simple de nivel de audio usando AnalyserNode para priorizar la voz más cercana
   */
  _startLevelMonitor(audioContext, mediaStream) {
    if (!audioContext || !mediaStream) return;
    try {
      const source = audioContext.createMediaStreamSource(mediaStream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      source.connect(analyser);

      const monitor = {
        audioContext,
        source,
        analyser,
        dataArray,
        rafId: null
      };

      const tick = () => {
        try {
          analyser.getByteTimeDomainData(dataArray);
          // Calcular RMS normalizado 0..1
          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) {
            const v = (dataArray[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / dataArray.length);

          // Inicializar _lastLevel si es null, luego suavizar
          if (this._lastLevel === null) {
            this._lastLevel = rms;
          } else {
            this._lastLevel = (this._lastLevel * this.levelSmoothing) + (rms * (1 - this.levelSmoothing));
          }

          // Debug log para ver valores
          if (Math.random() < 0.01) { // 1% de las veces para no saturar console
            console.log('RMS:', rms.toFixed(4), 'Smoothed:', this._lastLevel.toFixed(4), 'Threshold:', this.levelThreshold.toFixed(4));
          }
        } catch (e) {
          console.warn('Level monitor tick error', e);
        }
        monitor.rafId = requestAnimationFrame(tick);
      };

      monitor.rafId = requestAnimationFrame(tick);
      this._levelMonitor = monitor;
    } catch (e) {
      console.warn('Error iniciando nivel monitor', e);
    }
  }

  /**
   * Detiene el monitor de nivel si existe
   */
  _stopLevelMonitor() {
    if (!this._levelMonitor) return;
    try {
      if (this._levelMonitor.rafId) cancelAnimationFrame(this._levelMonitor.rafId);
      try { this._levelMonitor.source.disconnect(); } catch (e) { }
      try { this._levelMonitor.analyser.disconnect(); } catch (e) { }
    } catch (e) { console.warn('Error deteniendo level monitor', e); }
    this._levelMonitor = null;
    this._lastLevel = null;
  }

  /**
   * Envía texto directamente a OpenAI Realtime
   * @param {string} text - Texto a procesar
   */
  sendToOpenAI(text) {
    this.socket.emit('text_input', {
      text: text,
      conversation_id: this.conversationId
    });
  }

  /**
   * Habla un mensaje usando síntesis de voz
   * @param {string} text - Texto a hablar
   */
  speak(text) {
    console.log('speak() called with text:', text);
    console.log('speechSynthesis supported:', !!window.speechSynthesis);
    console.log('current voices:', (window.speechSynthesis && window.speechSynthesis.getVoices) ? window.speechSynthesis.getVoices().map(v => v.name + '(' + v.lang + ')') : []);

    // Evitar solapamiento: detener reconocimiento o grabación antes de TTS
    try {
      if (this.listening && this.recognition) {
        try { this.recognition.stop(); } catch (e) { }
        this.listening = false;
        this.recognitionStarting = false;
      }
      // Manejo robusto del mediaRecorder: preferir pause/resume si está disponible,
      // si no, hacer stop y marcar para reiniciar después de TTS.
      this._mediaWasPaused = false;
      this._mediaWasStopped = false;
      if (this.recording && this.mediaRecorder) {
        try {
          if (typeof this.mediaRecorder.pause === 'function') {
            this.mediaRecorder.pause();
            this._mediaWasPaused = true;
            console.log('mediaRecorder paused before TTS');
          } else {
            // stop and remember to restart
            try { this.mediaRecorder.stop(); } catch (e) { console.warn('mediaRecorder stop failed', e); }
            this._mediaWasStopped = true;
            this.recording = false;
            console.log('mediaRecorder stopped before TTS (will restart after)');
          }
        } catch (e) {
          console.warn('Error handling mediaRecorder before TTS', e);
        }
      }
    } catch (e) {
      console.warn('No se pudo pausar micrófono antes de TTS', e);
    }

    // Crear objeto de pronunciación
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'es-ES'; // Cambiar a es-ES que es más común
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.volume = 0.8;

    console.log('Voz española disponible:', this.spanishVoice ? this.spanishVoice.name : 'ninguna');
    if (this.spanishVoice) {
      utterance.voice = this.spanishVoice;
      console.log('Usando voz:', this.spanishVoice.name, '(' + this.spanishVoice.lang + ')');
    } else {
      console.log('Usando voz por defecto del sistema con lang es-ES');
    }

    // Manejo de estado y retry en caso de 'interrupted'
    let retried = false;

    utterance.onstart = () => {
      console.log('Iniciando habla:', text.substring(0, 80) + '...');
      this.isSpeaking = true;
      try { document.body.classList.add('speaking'); } catch (e) { }
      this.updateStatus('Hablando...', 'blue');
    };

    utterance.onend = () => {
      console.log('Habla finalizada');
      this.isSpeaking = false;
      try { document.body.classList.remove('speaking'); } catch (e) { }
      // Esperar un pequeño margen antes de reanudar micrófono
      setTimeout(() => {
        // Restaurar mediaRecorder si lo habíamos pausado o detenido
        try {
          if (this._mediaWasPaused && this.mediaRecorder && typeof this.mediaRecorder.resume === 'function') {
            try { this.mediaRecorder.resume(); this._mediaWasPaused = false; this.recording = true; console.log('mediaRecorder resumed after TTS'); } catch (e) { console.warn('resume failed', e); }
          } else if (this._mediaWasStopped && this.mediaRecorder) {
            try { this.mediaRecorder.start(250); this._mediaWasStopped = false; this.recording = true; console.log('mediaRecorder restarted after TTS'); } catch (e) { console.warn('restart failed', e); }
          }
        } catch (e) { console.warn('Error restoring mediaRecorder after TTS', e); }

        if (this.conversationActive && !this.recording && !this.listening) {
          this.startListening();
        }
      }, 350);
      if (this.conversationActive) this.updateStatus('Escuchando...', 'blue');
      else this.updateStatus('Listo', 'green');
    };

    utterance.onerror = (event) => {
      console.error('Error en síntesis de voz:', event.error);
      this.isSpeaking = false;
      try { document.body.classList.remove('speaking'); } catch (e) { }
      // Si fue interrumpido, intentar un reintento corto una vez
      if (event.error === 'interrupted' && !retried) {
        retried = true;
        console.log('Utterance interrumpida, reintentando en 250ms');
        setTimeout(() => {
          try { window.speechSynthesis.speak(utterance); } catch (e) { console.error('Reintento falló', e); }
        }, 250);
        return;
      }

      this.updateStatus('Error de voz', 'red');
      this.showSystemMessage('No fue posible reproducir el audio. Intenta de nuevo.');

      // Continuar con el flujo aunque falle TTS
      if (this.conversationActive && !this.recording && !this.listening) {
        setTimeout(() => this.startListening(), 500);
      }
    };

    console.log('Iniciando speechSynthesis.speak()');

    // Asegurar que speechSynthesis esté listo
    if (window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
    }

    // Cancelar cualquier utterance anterior
    window.speechSynthesis.cancel();

    // Pequeña pausa antes de hablar
    setTimeout(() => {
      try {
        window.speechSynthesis.speak(utterance);
        console.log('speechSynthesis.speak() ejecutado');
      } catch (e) {
        console.error('Error ejecutando speak():', e);
        // Si falla, simular que terminó para continuar el flujo
        if (this.conversationActive && !this.recording && !this.listening) {
          setTimeout(() => this.startListening(), 500);
        }
      }
    }, 100);
  }

  /**
   * Añade un mensaje al área de chat
   * @param {string} role - Rol del mensaje ('user', 'assistant', 'system')
   * @param {string} content - Contenido del mensaje
   */
  addMessage(role, content) {
    // Crear elemento de mensaje
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${role}`;

    // Crear contenido del mensaje
    const contentP = document.createElement('p');
    contentP.className = 'message-content';
    contentP.textContent = content;

    // Crear timestamp
    const timestamp = document.createElement('div');
    timestamp.className = 'message-timestamp';
    timestamp.textContent = new Date().toLocaleTimeString('es-ES', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    // Combinar elementos
    messageDiv.appendChild(contentP);
    messageDiv.appendChild(timestamp);

    // Añadir al área de chat
    this.chatArea.appendChild(messageDiv);

    // Auto-scroll al final
    this.chatArea.scrollTop = this.chatArea.scrollHeight;

    // Guardar estado en localStorage para persistencia en caso de recarga
    this.saveChatState();
  }

  /**
   * Muestra un mensaje del sistema
   * @param {string} content - Contenido del mensaje
   */
  showSystemMessage(content) {
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message system';
    messageDiv.innerHTML = `<p class="message-content">${content}</p>`;

    this.chatArea.appendChild(messageDiv);
    this.chatArea.scrollTop = this.chatArea.scrollHeight;
  }

  /**
   * Actualiza el estado mostrado en la interfaz
   * @param {string} message - Mensaje de estado
   * @param {string} color - Color del estado ('red', 'green', 'orange', 'blue')
   */
  updateStatus(message, color) {
    this.status.textContent = `Estado: ${message}`;

    // Establecer color
    this.status.style.color = color;

    // Clases CSS para animaciones
    if (color === 'red') {
      this.status.classList.add('status-error');
      this.status.classList.remove('status-success', 'status-warning', 'status-info');
    } else if (color === 'green') {
      this.status.classList.add('status-success');
      this.status.classList.remove('status-error', 'status-warning', 'status-info');
    } else if (color === 'orange') {
      this.status.classList.add('status-warning');
      this.status.classList.remove('status-error', 'status-success', 'status-info');
    } else if (color === 'blue') {
      this.status.classList.add('status-info');
      this.status.classList.remove('status-error', 'status-success', 'status-warning');
    }
  }

  /**
   * Guarda manualmente la conversación actual
   */
  async saveConversation() {
    if (!this.conversationId) {
      this.showSystemMessage('No hay conversación activa para guardar.');
      return;
    }

    try {
      // Enviar solicitud de guardado manual
      const response = await fetch('/api/save_manual', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          conversation_id: this.conversationId
        })
      });

      if (!response.ok) {
        throw new Error(`Error HTTP: ${response.status}`);
      }

      const data = await response.json();

      if (data.error) {
        throw new Error(data.error);
      }

      // Mostrar mensaje de éxito
      this.showSystemMessage(data.message);
      console.log('Conversación guardada manualmente');

    } catch (error) {
      console.error('Error guardando conversación:', error);
      this.showSystemMessage('Error al guardar la conversación manualmente.');
    }
  }

  /**
   * Guarda el estado actual del chat en localStorage
   */
  saveChatState() {
    if (!this.conversationId) return;

    const chatState = {
      conversationId: this.conversationId,
      messages: Array.from(this.chatArea.children).map(el => ({
        role: el.className.replace('message ', ''),
        content: el.querySelector('.message-content')?.textContent || '',
        timestamp: el.querySelector('.message-timestamp')?.textContent || ''
      })),
      timestamp: Date.now()
    };

    try {
      localStorage.setItem(`voice_assistant_chat_${this.conversationId}`, JSON.stringify(chatState));
    } catch (error) {
      console.warn('No se pudo guardar el estado del chat:', error);
    }
  }

  /**
   * Carga el estado del chat desde localStorage
   */
  loadChatState() {
    if (!this.conversationId) return;

    try {
      const savedState = localStorage.getItem(`voice_assistant_chat_${this.conversationId}`);
      if (savedState) {
        const chatState = JSON.parse(savedState);

        // Verificar que el estado no esté demasiado viejo (más de 24 horas)
        if (Date.now() - chatState.timestamp < 24 * 60 * 60 * 1000) {
          // Limpiar chat actual
          this.chatArea.innerHTML = '';

          // Restaurar mensajes
          chatState.messages.forEach(msg => {
            const messageDiv = document.createElement('div');
            messageDiv.className = `message ${msg.role}`;
            messageDiv.innerHTML = `
                        <p class="message-content">${msg.content}</p>
                        <div class="message-timestamp">${msg.timestamp}</div>
                    `;
            this.chatArea.appendChild(messageDiv);
          });

          console.log('Estado del chat restaurado');
        }
      }
    } catch (error) {
      console.warn('No se pudo cargar el estado del chat:', error);
    }
  }

  /**
   * Limpia todos los recursos utilizados por el asistente
   */
  async destroy() {
    // Detener cualquier actividad en curso
    this.stopListening();
    this.stopRecording();
    this.stopConversation();

    // Cancelar cualquier habla en curso
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }

    // Cerrar conexión Socket.IO
    if (this.socket) {
      this.socket.disconnect();
    }

    // Limpiar estado de chat
    if (this.conversationId) {
      try {
        localStorage.removeItem(`voice_assistant_chat_${this.conversationId}`);
      } catch (error) {
        console.warn('No se pudo limpiar el estado del chat:', error);
      }
    }

    console.log('Asistente de voz destruido');
  }
}

/**

Inicializar la aplicación cuando el DOM esté listo
*/
document.addEventListener('DOMContentLoaded', () => {
  // Verificar soporte de APIs necesarias
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  // Verificar que las APIs necesarias estén disponibles
  const missingFeatures = [];

  if (!SpeechRecognition) {
    missingFeatures.push('Reconocimiento de voz (Web Speech API)');
  }

  if (!window.speechSynthesis) {
    missingFeatures.push('Síntesis de voz (SpeechSynthesis)');
  }

  if (!window.MediaRecorder) {
    missingFeatures.push('Grabación de audio (MediaRecorder)');
  }

  if (!window.WebSocket) {
    missingFeatures.push('WebSockets');
  }

  // Mostrar advertencia si faltan características importantes
  if (missingFeatures.length > 0) {
    const warning = document.createElement('div');
    warning.style.cssText = 'position: fixed; top: 20px; right: 20px; background: #f8d7da; color: #721c24; padding: 15px; border: 1px solid #f5c6cb; border-radius: 5px; z-index: 1000; max-width: 400px; font-family: Arial, sans-serif; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);';

    warning.innerHTML = `
        <strong>Advertencia:</strong><br>
        Algunas funciones pueden no estar disponibles:<br>
        <ul style="margin: 5px 0; padding-left: 20px;">
            ${missingFeatures.map(feature => `<li>${feature}</li>`).join('')}
        </ul>
        <small>Se recomienda usar Chrome o Edge para mejor experiencia.</small>
    `;

    document.body.appendChild(warning);

    // Auto-ocultar después de 10 segundos
    setTimeout(() => {
      if (warning.parentNode) {
        warning.parentNode.removeChild(warning);
      }
    }, 10000);
  }

  // Inicializar el asistente de voz
  try {
    window.voiceAssistant = new VoiceAssistant();
    // Conectar el slider de umbral si existe
    const levelSlider = document.getElementById('levelThreshold');
    const levelOutput = document.getElementById('levelThresholdValue');
    if (levelSlider && levelOutput && window.voiceAssistant) {
      // Inicializar valor mostrado
      levelOutput.value = parseFloat(levelSlider.value).toFixed(3);
      // Acción al mover slider
      levelSlider.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        window.voiceAssistant.levelThreshold = v;
        levelOutput.value = v.toFixed(3);
      });
      // Sincronizar con el valor por defecto del asistente
      levelSlider.value = window.voiceAssistant.levelThreshold;
      levelOutput.value = window.voiceAssistant.levelThreshold.toFixed(3);
    }
    // Hook calibrate button
    const calibrateBtn = document.getElementById('calibrateBtn');
    if (calibrateBtn && window.voiceAssistant) {
      calibrateBtn.addEventListener('click', () => {
        try { window.voiceAssistant.calibrateLevel(); } catch (e) { console.warn('Calibración falló', e); }
      });
    }

    // Start UI update loop for level meter
    const levelLoop = () => {
      try { if (window.voiceAssistant) window.voiceAssistant._updateLevelUI(); } catch (e) { }
      requestAnimationFrame(levelLoop);
    };
    requestAnimationFrame(levelLoop);
    // Manejar descarga de la página
    window.addEventListener('beforeunload', () => {
      if (window.voiceAssistant) {
        window.voiceAssistant.destroy();
      }
    });

    // Manejar visibilidad de la página
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && window.voiceAssistant) {
        // Pausar actividades cuando la página no está visible
        window.voiceAssistant.stopListening();
        if (window.speechSynthesis) {
          window.speechSynthesis.pause();
        }
      } else if (window.voiceAssistant) {
        // Reanudar actividades cuando la página vuelve a estar visible
        if (window.speechSynthesis) {
          window.speechSynthesis.resume();
        }
      }
    });

    console.log('Asistente de voz legal inicializado correctamente');

  } catch (error) {
    console.error('Error al inicializar el asistente de voz:', error);
    const errorDiv = document.createElement('div');
    errorDiv.style.cssText = 'position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: #f8d7da; color: #721c24; padding: 20px; border: 1px solid #f5c6cb; border-radius: 5px; text-align: center; font-family: Arial, sans-serif; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1); max-width: 400px;';
    errorDiv.innerHTML = `
    <h3>Error de Inicialización</h3>
    <p>Hubo un problema al iniciar el asistente de voz.</p>
    <p style="font-size: 0.9em; margin-top: 10px;">${error.message}</p>
`;
    document.body.appendChild(errorDiv);
  }
});

// Exportar para uso en módulos (si es compatible)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = VoiceAssistant;
}

