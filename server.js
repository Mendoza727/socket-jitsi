const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();
// Permitir CORS para HTTP requests
app.use(cors({ origin: '*' }));
app.use(express.json());

const server = http.createServer(app);
// Configurar Socket.IO con CORS abierto
const io = new Server(server, {
  cors: { origin: '*' }
});

// Almacén en memoria de salas
const rooms = {};

// Función para generar nombres de sala amigables
function generateFriendlyRoomName() {
  const adjectives = ['azul', 'verde', 'rojo', 'amarillo', 'morado', 'rosa', 'naranja', 'gris'];
  const nouns = ['leon', 'tigre', 'aguila', 'lobo', 'oso', 'gato', 'perro', 'pez'];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const num = Math.floor(Math.random() * 100);
  return `${adj}-${noun}-${num}`;
}

// Endpoint HTTP para crear sala
app.post('/create-room', (req, res) => {
  const { owner } = req.body;
  const roomId = uuidv4();
  const friendlyName = generateFriendlyRoomName();

  console.log(friendlyName);
  
  rooms[roomId] = {
    owner,
    friendlyName,
    members: [],
    invites: [],
    chat: [],
    questions: [],
    whiteboard: [],
    polls: [],
    joinRequests: []
  };
  
  res.json({ roomId, friendlyName });
});

// Buscar sala por nombre amigable
app.get('/find-room/:friendlyName', (req, res) => {
  const { friendlyName } = req.params;
  console.log(`Buscando sala con nombre amigable: ${friendlyName}`);

  const room = Object.entries(rooms).find(
    ([id, room]) => room.friendlyName === friendlyName
  );

  if (room) {
    console.log(`Sala encontrada: ID = ${room[0]}, Nombre = ${room[1].friendlyName}`);
    res.json({ roomId: room[0], exists: true });
  } else {
    console.log('Sala no encontrada');
    res.json({ exists: false });
  }
});


// Socket.IO handlers
io.on('connection', socket => {
  console.log('Usuario conectado:', socket.id);

  // Crear sala vía socket (opcional si usas solo HTTP)
  socket.on('create-room', ({ owner }) => {
    const roomId = uuidv4();
    const friendlyName = generateFriendlyRoomName();
    rooms[roomId] = { 
      owner, 
      friendlyName,
      members: [], 
      invites: [], 
      chat: [], 
      questions: [], 
      whiteboard: [], 
      polls: [],
      joinRequests: []
    };
    socket.join(roomId);
    socket.emit('room-created', { roomId, friendlyName });
  });

  // Invitar participante
  socket.on('invite', ({ roomId, invitee }) => {
    const room = rooms[roomId]; 
    if (!room) return;
    
    if (!room.invites.includes(invitee)) {
      room.invites.push(invitee);
    }
    
    // Notificar al propietario que se envió la invitación
    socket.emit('invitation-sent', { roomId, invitee });
  });

  // Solicitud de unión
  socket.on('join-request', ({ roomId, user }) => {
    const room = rooms[roomId]; 
    if (!room) {
      socket.emit('room-not-found', { roomId });
      return;
    }

    // Si es el propietario o está invitado, unirse directamente
    if (user === room.owner || room.invites.includes(user)) {
      if (!room.members.includes(user)) {
        room.members.push(user);
      }
      socket.join(roomId);
      socket.emit('join-approved', { roomId, members: room.members });
      socket.to(roomId).emit('member-joined', { user, members: room.members });
    } else {
      // Si no está invitado, agregar a solicitudes pendientes
      if (!room.joinRequests.includes(user)) {
        room.joinRequests.push(user);
      }
      
      // Notificar al propietario sobre la solicitud
      const ownerSocket = [...io.sockets.sockets.values()]
        .find(s => s.rooms.has(roomId) && s.userId === room.owner);
      
      if (ownerSocket) {
        ownerSocket.emit('join-request', { roomId, user });
      }
      
      socket.emit('join-pending', { roomId, user });
    }
  });

  // Aceptar solicitud de unión
  socket.on('accept-join', ({ roomId, user }) => {
    const room = rooms[roomId];
    if (!room) return;
    
    // Remover de solicitudes pendientes
    room.joinRequests = room.joinRequests.filter(u => u !== user);
    
    // Agregar a miembros si no está ya
    if (!room.members.includes(user)) {
      room.members.push(user);
    }
    
    // Encontrar el socket del usuario y unirlo a la sala
    const userSocket = [...io.sockets.sockets.values()]
      .find(s => s.userId === user);
    
    if (userSocket) {
      userSocket.join(roomId);
      userSocket.emit('join-approved', { roomId, members: room.members });
    }
    
    // Notificar a todos los miembros
    io.in(roomId).emit('member-joined', { user, members: room.members });
  });

  // Rechazar solicitud de unión
  socket.on('reject-join', ({ roomId, user }) => {
    const room = rooms[roomId];
    if (!room) return;
    
    // Remover de solicitudes pendientes
    room.joinRequests = room.joinRequests.filter(u => u !== user);
    
    // Notificar al usuario que fue rechazado
    const userSocket = [...io.sockets.sockets.values()]
      .find(s => s.userId === user);
    
    if (userSocket) {
      userSocket.emit('join-rejected', { roomId });
    }
  });

  // Eliminar sala
  socket.on('delete-room', ({ roomId, user }) => {
    const room = rooms[roomId];
    if (room && room.owner === user) {
      // Notificar a todos los miembros que la sala fue eliminada
      io.in(roomId).emit('room-deleted', { roomId });
      
      // Eliminar la sala
      delete rooms[roomId];
    }
  });

  // Chat en tiempo real
  socket.on('chat-message', ({ roomId, message }) => {
    const room = rooms[roomId]; 
    if (!room) return;
    
    const chatMessage = {
      id: uuidv4(),
      from: message.from,
      text: message.text,
      timestamp: new Date().toISOString()
    };
    
    room.chat.push(chatMessage);
    
    // Enviar a todos los miembros de la sala
    io.in(roomId).emit('chat-message', chatMessage);
  });

  // Establecer ID de usuario para el socket
  socket.on('set-user-id', ({ userId }) => {
    socket.userId = userId;
  });

  // Preguntas y respuestas en tiempo real
  socket.on('ask-question', ({ roomId, question }) => {
    const room = rooms[roomId]; 
    if (!room) return;
    const q = { id: uuidv4(), question, answers: [] };
    room.questions.push(q);
    io.in(roomId).emit('new-question', q);
  });

  socket.on('answer-question', ({ roomId, questionId, answer }) => {
    const room = rooms[roomId]; 
    if (!room) return;
    const q = room.questions.find(q => q.id === questionId);
    if (!q) return;
    q.answers.push(answer);
    io.in(roomId).emit('question-updated', q);
  });

  // Pizarra cooperativa
  socket.on('whiteboard-draw', ({ roomId, drawData }) => {
    const room = rooms[roomId]; 
    if (!room) return;
    room.whiteboard.push(drawData);
    socket.to(roomId).emit('whiteboard-draw', drawData);
  });

  // Encuestas (polls)
  socket.on('create-poll', ({ roomId, poll }) => {
    const room = rooms[roomId]; 
    if (!room) return;
    const p = { id: uuidv4(), ...poll, votes: [] };
    room.polls.push(p);
    io.in(roomId).emit('new-poll', p);
  });

  socket.on('vote-poll', ({ roomId, pollId, vote }) => {
    const room = rooms[roomId]; 
    if (!room) return;
    const p = room.polls.find(p => p.id === pollId);
    if (!p) return;
    p.votes.push(vote);
    io.in(roomId).emit('poll-updated', p);
  });

  // Exportar datos: chat, whiteboard, polls, questions
  socket.on('export-data', ({ roomId, type }) => {
    const room = rooms[roomId]; 
    if (!room) return;
    const data = room[type] || [];
    socket.emit('export-ready', { type, data });
  });

  // Manejar desconexión
  socket.on('disconnect', () => {
    console.log('Usuario desconectado:', socket.id);
  });
});

// Arrancar servidor
server.listen(4000, () => {
  console.log('Servidor Socket.IO escuchando en http://localhost:4000');
});