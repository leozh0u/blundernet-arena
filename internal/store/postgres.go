package store

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/leozh0u/blundernet-arena/internal/game"
)

const schema = `
CREATE TABLE IF NOT EXISTS games (
    id           UUID PRIMARY KEY,
    player_color TEXT NOT NULL CHECK (player_color IN ('white','black')),
    result       TEXT NOT NULL,
    termination  TEXT NOT NULL,
    moves        TEXT NOT NULL,
    ply          INT  NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL,
    finished_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);`

type Archive struct {
	pool *pgxpool.Pool
}

func NewArchive(ctx context.Context, url string) (*Archive, error) {
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, err
	}
	if _, err := pool.Exec(ctx, schema); err != nil {
		pool.Close()
		return nil, err
	}
	return &Archive{pool: pool}, nil
}

func (a *Archive) Close() { a.pool.Close() }

// SaveFinished archives a completed game. Idempotent: both the api and the
// worker may try to archive the same game, so replays are no-ops.
func (a *Archive) SaveFinished(ctx context.Context, g *game.Game) error {
	_, err := a.pool.Exec(ctx, `
		INSERT INTO games (id, player_color, result, termination, moves, ply, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (id) DO NOTHING`,
		g.ID, g.PlayerColor, g.Result, g.Termination,
		strings.Join(g.Moves, " "), g.Ply, g.CreatedAt)
	return err
}

type Stats struct {
	Total      int `json:"total"`
	EngineWins int `json:"engine_wins"`
	PlayerWins int `json:"player_wins"`
	Draws      int `json:"draws"`
}

func (a *Archive) Stats(ctx context.Context) (*Stats, error) {
	var s Stats
	err := a.pool.QueryRow(ctx, `
		SELECT count(*),
		       count(*) FILTER (WHERE (player_color = 'white' AND result = '0-1')
		                            OR (player_color = 'black' AND result = '1-0')),
		       count(*) FILTER (WHERE (player_color = 'white' AND result = '1-0')
		                            OR (player_color = 'black' AND result = '0-1')),
		       count(*) FILTER (WHERE result = '1/2-1/2')
		FROM games`).Scan(&s.Total, &s.EngineWins, &s.PlayerWins, &s.Draws)
	if err != nil {
		return nil, err
	}
	return &s, nil
}
