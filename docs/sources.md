# Classic RIF rules and opening research

Checked against public sources on 2026-10-28. This game uses the classic RIF opening procedure, not the newer Taraguchi-10 procedure currently shown on the RIF starting-game tutorial.

## Authoritative rules

- [International Rules of Renju](https://www.renju.net/rifrules/), decided 1996-05-02, corrected 1998-05-03. Primary source for definitions, forbidden moves, and the classic opening.
- [Classic Rule](https://www.renju.net/rule/1/). Official concise statement of the same opening, including the ban on symmetrical fifth proposals.
- [Advanced Tutorial](https://www.renju.net/advanced/). Official illustrated examples of fake threes and fake fours.
- [26 Renju Openings](https://www.renju.net/openings/). Official names and numbered coordinate diagrams.
- [Game Search](https://www.renju.net/game/search/). Official opening ID list and Japanese/Chinese characters. Traditional Chinese labels below use familiar local variants of those characters.

## Classic opening sequence

The tentative first player places all three stones, B-W-B, selecting one of 26 standard patterns. B1 is the centre; W2 is adjacent in the central 3×3 square; B3 is in the central 5×5 square. Rotation/reflection gives equivalent orientations of the same named opening.

Exact excerpts from international rules §12:

> 12.2-4.The tentative Black plays all the first three moves (two moves for black and one move for white i.e. he decides which of the 26 patterns that will be used.)

> 12.5 The tentative White decides which of the players that will play as Black and as White in the game (White has the right to change sides).

> 12.6 The now decided player beeing White makes the 4th move in a optional unoccupied intersection.

> 12.7 BLACK'S CHOICE Black (the player with the black stones) has to make two different proposals for 5th stone. The proposals have to be unequal in all respects White has the right to choose one of the two proposals from Black to become the 5th move of the game.

> For White the time goes till he has accepted one of the proposals and till he has made the 6th move which can be made in any unoccupied intersection.

The official [Classic Rule](https://www.renju.net/rule/1/) clarifies:

> The black player puts two 5th moves on the board (symmetrical moves not allowed).

Thus: one colour choice after B-W-B; decided White places W4 anywhere empty; decided Black proposes two inequivalent B5 choices; White selects one, the other disappears, and White places W6 anywhere empty. Normal alternating play follows. There is no second colour swap after the fourth or fifth move in this rule.

Symmetry interpretation for implementation: two proposed points are equivalent if a symmetry of the square board maps one to the other while preserving the existing four-stone coloured position. Test the eight D4 transforms and retain only transforms that preserve that position. Existing stone colours, rather than their move labels, define the position. A reflected point is permissible if the reflection does not also preserve the current position. This is the operational interpretation of “symmetrical”; the rule page does not publish an algorithm.

The [Starting the Game](https://www.renju.net/starting/) page and its legacy `/study/starting.php` redirect now describe **Taraguchi-10**, which has multiple swaps and ten fifth offers. Do not apply that protocol to classic RIF.

## Winning and forbidden move definitions

The board is 15×15 (§2). White wins with five or more contiguous stones; Black wins with exactly five contiguous stones.

Exact rule §9.1:

> The winner of the game is the player who will be first to attain five in a row. For white is also overline counted as a win.

Exact rule §9.2:

> The game is won for white if black without at the same time attaining five in a row:
> a) makes an overline;
> b) makes a double-four;
> c) makes a double-three (however there are some double-threes, which black are allowed to make, see 9.3);

Consequently, for a newly placed Black stone, test an exact five first. An exact five wins even if that same move creates an overline or a forbidden fork in another direction. Without an exact five, an overline, double-four, or genuine double-three loses. An overline alone is never a Black win. This ordering follows the express “without at the same time” exception, not a simplified gomoku pattern check.

Exact definitions from §3:

> FOUR: A row with four stones to which you can add one more stone to attain five in a row.

> STRAIGHT FOUR: An unbroken row with four stones ("four") to which you, in two different ways, can add one more stone to attain five in a row.

> THREE: A row with three stones to which you, without at the same time a five in a row is made, can add one more stone to attain a straight four.

> DOUBLE-FOUR: Putting a stone on an intersection, which at the same time makes more than one four that meet each other in this intersection.

> DOUBLE-THREE: Putting a stone on an intersection, which at the same time makes more than one three that meet each other in this intersection.

Count formations, not directions or winning endpoints. A single straight four has two winning endpoints but remains one four. Two different broken fours can be in the same direction and count as a double-four. For example, on an otherwise empty horizontal line, existing Black offsets `-3,-1,+1,+3`, then Black at `0`, create distinct fours with gaps `-2` and `+2`.

## Genuine and fake threes

Exact rule §9.3(a), relevant excerpt:

> Not more than one of the three's can be made to a straight four when adding another stone in just any intersection, without at the same time an overline or double-four is attained in this intersection.

Exact rule §9.3(b), relevant excerpt:

> Not more than one of the three's can be made to a straight four when adding another stone in just any intersection, without at the same time at least two three's meet in this intersection and make a forbidden double-three.

The same clause explicitly requires recursion:

> If, when making a straight four in your mind, another double-three would be attained also these double-three's must be examined in the same way as it is described in this point 9.3, etc.

A visual three counts only when at least one hypothetical extension forms a straight four, forms no five simultaneously (the §3 definition), and is not itself prohibited by overline, double-four, or a recursively genuine double-three. Both ends of the resulting straight four must produce exact fives, so an end that would extend to an overline does not qualify. Board edges and White stones also invalidate a required end.

The [Advanced Tutorial](https://www.renju.net/advanced/) verifies both kinds of false pattern: a three whose extension can only produce a half-open four or overline; and a three whose otherwise suitable extensions are prohibited by double-four. It also shows a fake four whose only nominal completion produces an overline.

## Verified 26 opening coordinates

Offsets use `(dx, dy)` relative to B1 `(0,0)`, with **x increasing right and y increasing down**. On a zero-indexed 15×15 board, add `(7,7)`. Direct openings have W2 `(0,-1)`; indirect openings have W2 `(1,-1)`. B3 is the coordinate in the table. Apply board rotation/reflection to generate other orientations.

Direct diagram: <https://www.renju.net/upload/staticfiles/direct_openings.png>

Indirect diagram: <https://www.renju.net/upload/staticfiles/indirect_openings.png>

| ID | Traditional Chinese | Official romanization | B3 offset |
| --- | --- | --- | --- |
| d1 | 寒星 | Kansei | `(0,-2)` |
| d2 | 溪月 | Keigetsu | `(1,-2)` |
| d3 | 疏星 | Sosei | `(2,-2)` |
| d4 | 花月 | Kagetsu | `(1,-1)` |
| d5 | 殘月 | Zangetsu | `(2,-1)` |
| d6 | 雨月 | Ugetsu | `(1,0)` |
| d7 | 金星 | Kinsei | `(2,0)` |
| d8 | 松月 | Shogetsu | `(0,1)` |
| d9 | 丘月 | Kyugetsu | `(1,1)` |
| d10 | 新月 | Shingetsu | `(2,1)` |
| d11 | 瑞星 | Zuigetsu | `(0,2)` |
| d12 | 山月 | Sangetsu | `(1,2)` |
| d13 | 遊星 | Yusei | `(2,2)` |
| i1 | 長星 | Chosei | `(2,-2)` |
| i2 | 峽月 | Kyogetsu | `(2,-1)` |
| i3 | 恆星 | Kosei | `(2,0)` |
| i4 | 水月 | Suigetsu | `(2,1)` |
| i5 | 流星 | Ryusei | `(2,2)` |
| i6 | 雲月 | Ungetsu | `(1,0)` |
| i7 | 浦月 | Hogetsu | `(1,1)` |
| i8 | 嵐月 | Rangetsu | `(1,2)` |
| i9 | 銀月 | Gingetsu | `(0,1)` |
| i10 | 明星 | Myojo | `(0,2)` |
| i11 | 斜月 | Shagetsu | `(-1,1)` |
| i12 | 名月 | Meigetsu | `(-1,2)` |
| i13 | 彗星 | Suisei | `(-2,2)` |

## Opening balance: evidence and limits

[The Future of Renju, 1997](https://www.renju.net/article/39/) is an article by four-time world champion Ando Meritee, from *Renju World Magazine* No. 25, with comments by Yuriy Tarannikov, Mikhail Kozhin, and Aldis Reims. [Official hosted document](https://www.renju.net/article/39/download/). This is historical expert opinion about classic RIF, not an exhaustive current solved opening database.

Meritee writes:

> Right now, d3 and d8 give possibilities for both sides.

> Saying very radical, only i11, d3, d8, d9 can be played. (Maybe I am wrong about d11). Only 4 from 26!

He describes i11 and d9 as drawing openings and lists i8, i9, i10, and i12 as too favourable for Black. He describes i1 and i5 as openings White usually wins. Reims's reply is less absolute and regards i1, i5, d3, d8, d11, and i11 as “quite even positions”. Those disagreements make the four-opening shortlist **d3 / d8 / d9 / i11** a defensible historically sourced preference; they do not prove equal probabilities or perfect-play draws in the implemented browser engine.

The article contains “95% black win, maybe”. This is an informal, explicitly speculative phrase with no attached dataset or methodology. **It must not be used as a measured 95% win rate.**

Flower / d4 is widely reputed to favour Black. The secondary [Renju opening pattern](https://en.wikipedia.org/wiki/Renju_opening_pattern) page calls it “sure win for Black”, but that article carries a “needs more citations” notice, supplies no move-tree proof for that assertion, and links the official opening page which currently provides names/diagrams only. Meritee lists d4 among openings that “already can not be played”, without explicitly identifying the winning colour there. Therefore the checked sources do **not** justify recording a verified perfect-play binary outcome for d4. It may be treated as a conventional Black-advantage heuristic, with measured win rate and verified theoretical result left null.

No trustworthy calibrated online win-percent table covering these 26 openings was found in the checked official references. Their balance depends on opening rule, W4, offered B5 pair, the chosen B5, player strength, and the game sample. A rate table would require an identified dataset, inclusion criteria, sample size per opening, treatment of draws, and date. A shallow browser evaluation or an expert adjective cannot supply those facts.

## AI consequences

After a three-stone proposal, the other player chooses the colour. If a Black-centred evaluation is `v`, a perfect colour chooser leaves the proposer a value of `min(v,-v) = -abs(v)`. Choose openings close to balanced and prefer the sourced shortlist rather than maximising Black's advantage. If the AI is the chooser, choose the colour with the better evaluated value.

Black's two-fifth proposal is another opponent choice: Black should maximise the lower evaluation of its two permitted, non-equivalent proposals; White should choose the weaker Black continuation and then optimise W6.

If implementation uses numeric prior values such as balanced `0.5`, Black advantage `0.9`, White advantage `0.1`, and unknown `0.5`, those are **chosen heuristic prior scores**, not sourced probabilities. Keep measured win percentages null and name/display these values accordingly. An unknown opening assigned a neutral prior is not evidence of balance, so it should not outrank the sourced balanced shortlist merely because both have a neutral numeric prior.
