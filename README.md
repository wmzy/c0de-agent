# Mind Labyrinth - Puzzle RPG

A narrative puzzle RPG where players ascend through a cosmic tower, solving puzzles of increasing difficulty while experiencing an unfolding story.

## Features

- **Multiple Puzzle Types**: Slider, Cipher, Pattern, and Logic puzzles
- **Narrative System**: Dynamic story generation with prophecies, revelations, and dreams
- **Boss Encounters**: Multi-phase boss battles with puzzle sequences
- **Responsive Design**: Works on desktop, tablet, and mobile
- **Accessibility**: ARIA support, screen reader announcements, reduced motion options
- **Theme System**: Cosmic, Ancient, and Ethereal themes

## Tech Stack

- **Frontend**: React, TypeScript, Redux Toolkit, Tailwind CSS, Vite
- **Backend**: Node.js, Express, TypeScript
- **State Management**: Redux Toolkit with async thunks
- **Styling**: Tailwind CSS with custom themes

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn

### Installation

1. Install frontend dependencies:
   ```bash
   cd frontend
   npm install
   ```

2. Install backend dependencies:
   ```bash
   cd backend
   npm install
   ```

### Running the Application

1. Start the backend server:
   ```bash
   cd backend
   npm run dev
   ```

2. Start the frontend development server:
   ```bash
   cd frontend
   npm run dev
   ```

3. Open http://localhost:3000 in your browser

### Building for Production

1. Build the frontend:
   ```bash
   cd frontend
   npm run build
   ```

2. Build the backend:
   ```bash
   cd backend
   npm run build
   ```

## Project Structure

```
mind-labyrinth/
├── frontend/
│   ├── src/
│   │   ├── components/     # React components
│   │   ├── layouts/        # Layout components
│   │   ├── pages/          # Page components
│   │   ├── services/       # API and utility services
│   │   ├── store/          # Redux store and slices
│   │   └── styles/         # CSS and styling
│   └── package.json
├── backend/
│   ├── src/
│   │   ├── routes/         # API routes
│   │   └── services/       # Backend services
│   └── package.json
└── README.md
```

## API Endpoints

### Game
- `POST /api/game/session` - Start a new game session
- `GET /api/game/session/:sessionId` - Get game state
- `POST /api/game/puzzle/:puzzleId/solution` - Submit puzzle solution
- `GET /api/game/floor/:floorNumber` - Get floor information
- `GET /api/game/leaderboard` - Get leaderboard

### LLM
- `POST /api/llm/chat` - Chat with AI assistant
- `POST /api/llm/completion` - Get text completion
- `POST /api/llm/analyze-puzzle` - Analyze puzzle difficulty

### Narrative
- `GET /api/narrative/event/:eventId` - Get narrative event
- `GET /api/narrative/floor/:floorNumber` - Get floor narrative
- `POST /api/narrative/dialogue/:characterId` - Get character dialogue

### User
- `GET /api/user/profile` - Get user profile
- `PUT /api/user/profile` - Update user profile
- `GET /api/user/progress` - Get user progress
- `POST /api/user/progress` - Save user progress

## Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Acknowledgments

- Inspired by puzzle games and narrative RPGs
- Built with modern web technologies
- Designed for accessibility and responsiveness
