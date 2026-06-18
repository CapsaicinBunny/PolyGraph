package sample

import "math"

func Square(n float64) float64 {
	return n * n
}

func CircleArea(r float64) float64 {
	return math.Pi * Square(r)
}

func RectArea(w, h float64) float64 {
	return w * h
}
