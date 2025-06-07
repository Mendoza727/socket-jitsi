const express = require("express")
const http = require("http")
const { Server } = require("socket.io")
const cors = require("cors")

const app = express()
const server = http.createServer(app)

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
})

app.use(cors())

const PORT = process.env.PORT || 3001

// Store room participants with enhanced data
const rooms = new Map()
// Store room metadata for validation and management
const roomMetadata = new Map()

// Room management functions
function createRoom(roomId, creatorId, creatorName) {
  if (roomMetadata.has(roomId)) {
    return { success: false, error: "Room already exists" }
  }

  const roomInfo = {
    id: roomId,
    createdAt: new Date().toISOString(),
    createdBy: creatorId,
    creatorName: creatorName,
    isActive: true,
    maxParticipants: 50, // Configurable limit
  }

  roomMetadata.set(roomId, roomInfo)
  rooms.set(roomId, new Map())

  console.log(`🏠 Room created: ${roomId} by ${creatorName}`)
  return { success: true, roomInfo }
}

function validateRoomAccess(roomId, userId, isRoomOwner = false) {
  const roomInfo = roomMetadata.get(roomId)

  // If room doesn't exist and user wants to create it
  if (!roomInfo && isRoomOwner) {
    return { needsCreation: true }
  }

  // If room doesn't exist and user is not owner
  if (!roomInfo) {
    return { success: false, error: "Room does not exist" }
  }

  // If room is not active
  if (!roomInfo.isActive) {
    return { success: false, error: "Room has been deleted" }
  }

  // Check participant limit
  const currentRoom = rooms.get(roomId)
  if (currentRoom && currentRoom.size >= roomInfo.maxParticipants) {
    return { success: false, error: "Room is full" }
  }

  return { success: true, roomInfo }
}

function deleteRoom(roomId, userId) {
  const roomInfo = roomMetadata.get(roomId)

  if (!roomInfo) {
    return { success: false, error: "Room does not exist" }
  }

  if (roomInfo.createdBy !== userId) {
    return { success: false, error: "Only room owner can delete the room" }
  }

  // Mark room as inactive
  roomInfo.isActive = false

  // Get participants to notify
  const room = rooms.get(roomId)
  const participantsToNotify = room ? Array.from(room.values()) : []

  // Clean up
  rooms.delete(roomId)
  roomMetadata.delete(roomId)

  console.log(`🗑️ Room ${roomId} deleted by owner ${userId}`)
  return { success: true, participantsToNotify }
}

io.on("connection", (socket) => {
  console.log("✅ Usuario conectado:", socket.id)

  // Enhanced join room with validation
  socket.on("join-room", (data) => {
    try {
      const { roomId, userId, userName, isRoomOwner } = data

      // Validate room access
      const validation = validateRoomAccess(roomId, userId, isRoomOwner)

      if (validation.needsCreation && isRoomOwner) {
        // Create new room
        const createResult = createRoom(roomId, userId, userName)
        if (!createResult.success) {
          socket.emit("room-error", {
            type: "creation-failed",
            message: createResult.error,
            roomId,
          })
          return
        }
      } else if (!validation.success) {
        // Room validation failed
        socket.emit("room-error", {
          type: "access-denied",
          message: validation.error,
          roomId,
        })
        return
      }

      socket.join(roomId)
      socket.userId = userId
      socket.userName = userName
      socket.roomId = roomId
      socket.isRoomOwner = isRoomOwner || roomMetadata.get(roomId)?.createdBy === userId

      // Initialize room if it doesn't exist
      if (!rooms.has(roomId)) {
        rooms.set(roomId, new Map())
      }

      const room = rooms.get(roomId)
      room.set(userId, {
        userId,
        userName,
        socketId: socket.id,
        joinedAt: new Date().toISOString(),
        isConnected: true,
        isOwner: socket.isRoomOwner,
      })

      // Send room joined confirmation
      socket.emit("room-joined", {
        roomId,
        isOwner: socket.isRoomOwner,
        participantCount: room.size,
        roomInfo: roomMetadata.get(roomId),
      })

      // Notify others about new user
      socket.to(roomId).emit("user-joined", {
        userId,
        userName,
        isOwner: socket.isRoomOwner,
      })

      // Send current participants list to new user
      const participants = Array.from(room.values()).filter((p) => p.isConnected)
      socket.emit("participants-list", participants)

      console.log(
        `👤 ${userName} se unió a la sala ${roomId} (${participants.length} participantes)${socket.isRoomOwner ? " - OWNER" : ""}`,
      )
    } catch (error) {
      console.error("❌ Error en join-room:", error)
      socket.emit("error", { message: "Failed to join room" })
    }
  })

  // Handle room deletion
  socket.on("delete-room", (data) => {
    try {
      const { roomId } = data

      if (!socket.userId || socket.roomId !== roomId) {
        socket.emit("error", { message: "Invalid room or user" })
        return
      }

      const result = deleteRoom(roomId, socket.userId)

      if (!result.success) {
        socket.emit("error", { message: result.error })
        return
      }

      // Notify all participants
      result.participantsToNotify.forEach((participant) => {
        if (participant.socketId !== socket.id) {
          io.to(participant.socketId).emit("room-deleted", {
            roomId,
            message: "Room has been deleted by the owner",
          })
        }
      })

      // Confirm to owner
      socket.emit("room-deleted", {
        roomId,
        message: "Room deleted successfully",
      })
    } catch (error) {
      console.error("❌ Error deleting room:", error)
      socket.emit("error", { message: "Failed to delete room" })
    }
  })

  // Get room info
  socket.on("get-room-info", (data) => {
    try {
      const { roomId } = data
      const roomInfo = roomMetadata.get(roomId)
      const room = rooms.get(roomId)

      if (!roomInfo || !roomInfo.isActive) {
        socket.emit("room-error", {
          type: "not-found",
          message: "Room does not exist or has been deleted",
          roomId,
        })
        return
      }

      const participants = room ? Array.from(room.values()).filter((p) => p.isConnected) : []

      socket.emit("room-info", {
        ...roomInfo,
        participantCount: participants.length,
        participants: participants.map((p) => ({
          userId: p.userId,
          userName: p.userName,
          isOwner: p.isOwner,
          joinedAt: p.joinedAt,
        })),
      })
    } catch (error) {
      console.error("❌ Error getting room info:", error)
      socket.emit("error", { message: "Failed to get room info" })
    }
  })

  // Enhanced WebRTC Signaling with error handling
  socket.on("offer", (data) => {
    try {
      const { to, offer } = data
      console.log(`📞 Offer from ${socket.userId} to ${to}`)

      const room = rooms.get(socket.roomId)
      if (room && room.has(to)) {
        const targetSocketId = room.get(to).socketId
        io.to(targetSocketId).emit("offer", {
          from: socket.userId,
          offer: offer,
        })
      } else {
        console.warn(`⚠️  Target user ${to} not found for offer`)
      }
    } catch (error) {
      console.error("❌ Error handling offer:", error)
    }
  })

  socket.on("answer", (data) => {
    try {
      const { to, answer } = data
      console.log(`📞 Answer from ${socket.userId} to ${to}`)

      const room = rooms.get(socket.roomId)
      if (room && room.has(to)) {
        const targetSocketId = room.get(to).socketId
        io.to(targetSocketId).emit("answer", {
          from: socket.userId,
          answer: answer,
        })
      } else {
        console.warn(`⚠️  Target user ${to} not found for answer`)
      }
    } catch (error) {
      console.error("❌ Error handling answer:", error)
    }
  })

  socket.on("ice-candidate", (data) => {
    try {
      const { to, candidate } = data

      const room = rooms.get(socket.roomId)
      if (room && room.has(to)) {
        const targetSocketId = room.get(to).socketId
        io.to(targetSocketId).emit("ice-candidate", {
          from: socket.userId,
          candidate: candidate,
        })
      }
    } catch (error) {
      console.error("❌ Error handling ICE candidate:", error)
    }
  })

  // Enhanced chat with message validation
  socket.on("chat-message", (data) => {
    try {
      if (socket.roomId && data.message && data.message.trim().length > 0) {
        const messageData = {
          ...data,
          message: data.message.trim().substring(0, 500), // Limit message length
          timestamp: new Date().toISOString(),
          id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        }

        io.to(socket.roomId).emit("chat-message", messageData)
        console.log(
          `💬 ${data.userName}: ${messageData.message.substring(0, 50)}${messageData.message.length > 50 ? "..." : ""}`,
        )
      }
    } catch (error) {
      console.error("❌ Error handling chat message:", error)
    }
  })

  // Enhanced whiteboard with data validation
  socket.on("whiteboard-data", (data) => {
    try {
      if (socket.roomId && data.x0 !== undefined && data.y0 !== undefined) {
        // Validate drawing data
        const validatedData = {
          x0: Math.max(0, Math.min(2000, data.x0)),
          y0: Math.max(0, Math.min(2000, data.y0)),
          x1: Math.max(0, Math.min(2000, data.x1)),
          y1: Math.max(0, Math.min(2000, data.y1)),
          color: data.color || "#000000",
          size: Math.max(1, Math.min(50, data.size || 2)),
          tool: data.tool === "eraser" ? "eraser" : "pen",
        }

        socket.to(socket.roomId).emit("whiteboard-data", validatedData)
      }
    } catch (error) {
      console.error("❌ Error handling whiteboard data:", error)
    }
  })

  socket.on("whiteboard-clear", () => {
    try {
      if (socket.roomId) {
        socket.to(socket.roomId).emit("whiteboard-clear")
        console.log(`🧽 ${socket.userName} cleared the whiteboard`)
      }
    } catch (error) {
      console.error("❌ Error handling whiteboard clear:", error)
    }
  })

  // Enhanced disconnect handling
  socket.on("disconnect", (reason) => {
    console.log(`❌ Usuario desconectado: ${socket.id} (${reason})`)

    try {
      if (socket.roomId && socket.userId) {
        const room = rooms.get(socket.roomId)
        if (room) {
          // Mark user as disconnected instead of immediately removing
          const user = room.get(socket.userId)
          if (user) {
            user.isConnected = false
            user.disconnectedAt = new Date().toISOString()
          }

          // Notify others about user leaving
          socket.to(socket.roomId).emit("user-left", { userId: socket.userId })

          // Clean up after a delay to allow for reconnection
          setTimeout(() => {
            if (room.has(socket.userId)) {
              const user = room.get(socket.userId)
              if (!user.isConnected) {
                room.delete(socket.userId)
                console.log(`🗑️  Removed ${socket.userName} from room after timeout`)
              }
            }

            // Clean up empty rooms but keep metadata for a while
            if (room.size === 0) {
              rooms.delete(socket.roomId)
              console.log(`🗑️  Removed empty room ${socket.roomId}`)

              // Remove room metadata after longer delay
              setTimeout(() => {
                const roomInfo = roomMetadata.get(socket.roomId)
                if (roomInfo && (!rooms.has(socket.roomId) || rooms.get(socket.roomId).size === 0)) {
                  roomMetadata.delete(socket.roomId)
                  console.log(`🗑️  Removed room metadata ${socket.roomId}`)
                }
              }, 300000) // 5 minutes
            }
          }, 30000) // 30 second grace period
        }
      }
    } catch (error) {
      console.error("❌ Error handling disconnect:", error)
    }
  })

  // Handle reconnection
  socket.on("reconnect", () => {
    console.log(`🔄 Usuario reconectado: ${socket.id}`)
    if (socket.roomId && socket.userId) {
      const room = rooms.get(socket.roomId)
      if (room && room.has(socket.userId)) {
        const user = room.get(socket.userId)
        user.isConnected = true
        user.socketId = socket.id
        delete user.disconnectedAt
      }
    }
  })
})

// Health check endpoint
app.get("/health", (req, res) => {
  const roomCount = rooms.size
  const totalUsers = Array.from(rooms.values()).reduce((total, room) => total + room.size, 0)

  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    rooms: roomCount,
    users: totalUsers,
    uptime: process.uptime(),
  })
})

// Room statistics endpoint
app.get("/stats", (req, res) => {
  const stats = {
    rooms: Array.from(rooms.entries()).map(([roomId, participants]) => ({
      roomId,
      participantCount: participants.size,
      participants: Array.from(participants.values()).map((p) => ({
        userId: p.userId,
        userName: p.userName,
        isConnected: p.isConnected,
        joinedAt: p.joinedAt,
        isOwner: p.isOwner,
      })),
    })),
  }

  res.json(stats)
})

// New endpoint to check if room exists
app.get("/api/rooms/:roomId", (req, res) => {
  const { roomId } = req.params
  const roomInfo = roomMetadata.get(roomId)
  const room = rooms.get(roomId)

  if (!roomInfo || !roomInfo.isActive) {
    return res.status(404).json({
      exists: false,
      error: "Room not found or inactive",
    })
  }

  const participants = room ? Array.from(room.values()).filter((p) => p.isConnected) : []

  res.json({
    exists: true,
    room: {
      ...roomInfo,
      participantCount: participants.length,
      participants: participants.map((p) => ({
        userId: p.userId,
        userName: p.userName,
        isOwner: p.isOwner,
        joinedAt: p.joinedAt,
      })),
    },
  })
})

// List all active rooms
app.get("/api/rooms", (req, res) => {
  const activeRooms = Array.from(roomMetadata.entries())
    .filter(([_, roomInfo]) => roomInfo.isActive)
    .map(([roomId, roomInfo]) => {
      const room = rooms.get(roomId)
      const participantCount = room ? room.size : 0

      return {
        id: roomId,
        createdAt: roomInfo.createdAt,
        creatorName: roomInfo.creatorName,
        participantCount,
        maxParticipants: roomInfo.maxParticipants,
      }
    })

  res.json({ rooms: activeRooms })
})

server.listen(PORT, () => {
  console.log(`🚀 Servidor WebRTC Meet Pro ejecutándose en puerto ${PORT}`)
  console.log(`📹 Funcionalidades mejoradas:`)
  console.log(`   ✅ Video y audio real con WebRTC optimizado`)
  console.log(`   ✅ Grabación de llamadas con MediaRecorder`)
  console.log(`   ✅ Interfaz moderna con Tailwind CSS`)
  console.log(`   ✅ Compartir pantalla mejorado`)
  console.log(`   ✅ Chat en tiempo real con validación`)
  console.log(`   ✅ Tablero colaborativo optimizado`)
  console.log(`   ✅ Configuraciones de dispositivos`)
  console.log(`   ✅ Manejo robusto de errores`)
  console.log(`   ✅ Reconexión automática`)
  console.log(`   ✅ Gestión completa de salas`)
  console.log(`   ✅ Validación de propietarios`)
  console.log(`   ✅ Control de acceso a salas`)
  console.log(`\n🔧 Para usar la aplicación:`)
  console.log(`   1. Ejecuta este servidor: node server.js`)
  console.log(`   2. Abre tu aplicación Next.js en http://localhost:3000`)
  console.log(`   3. Permite acceso a cámara y micrófono`)
  console.log(`   4. ¡Disfruta tu videoconferencia profesional!`)
  console.log(`\n📊 Endpoints disponibles:`)
  console.log(`   • GET /health - Estado del servidor`)
  console.log(`   • GET /stats - Estadísticas de salas`)
  console.log(`   • GET /api/rooms - Lista de salas activas`)
  console.log(`   • GET /api/rooms/:roomId - Info de sala específica`)
  console.log(`\n⚠️  Nota: Para producción necesitarás HTTPS y servidores TURN`)
})
