"""Text router: the user dictionary and the reading preview (D19)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Body, Depends

from app.routers.deps import services
from app.schemas import (
    DictionaryEntry,
    DictionaryEntryInput,
    ReadingRequest,
    ReadingResult,
    ReadingToken,
)
from app.services.container import Services

router = APIRouter()

ServicesDep = Annotated[Services, Depends(services)]


@router.get("/dictionary", response_model=list[DictionaryEntry])
def get_dictionary(svc: ServicesDep) -> list[DictionaryEntry]:
    return svc.dictionary.list()


@router.put("/dictionary", response_model=list[DictionaryEntry])
def put_dictionary(
    entries: Annotated[list[DictionaryEntryInput], Body()], svc: ServicesDep
) -> list[DictionaryEntry]:
    """Replace the whole dictionary (the editor saves its table at once)."""
    return svc.dictionary.replace(entries)


@router.post("/text/reading", response_model=ReadingResult)
def reading(body: ReadingRequest, svc: ServicesDep) -> ReadingResult:
    """Estimated readings (katakana) of `text` after the user dictionary: a hint of how
    the words are usually read, not a guarantee of what the model will say."""
    if body.apply_dictionary:
        segments = list(svc.dictionary.apply(body.text).segments)
    else:
        segments = []
    tokens: list[ReadingToken] = []
    spoken_parts: list[str] = []
    for segment in segments or [None]:
        if segment is not None and segment.entry is not None:
            moras = svc.reader.moras(segment.text) or 0
            tokens.append(
                ReadingToken(
                    surface=segment.entry.surface,
                    reading=segment.text,
                    moras=moras,
                    source="dictionary",
                )
            )
            spoken_parts.append(segment.text)
            continue
        text = body.text if segment is None else segment.text
        spoken_parts.append(text)
        for token in svc.reader.tokens(text):
            tokens.append(
                ReadingToken(
                    surface=token.surface,
                    reading=token.reading,
                    moras=token.moras,
                    source=token.kind,
                )
            )
    spoken = "".join(spoken_parts)
    return ReadingResult(
        tokens=tokens,
        moras=sum(token.moras for token in tokens),
        estimated_seconds=svc.reader.estimate_seconds(spoken),
        analyzer=svc.reader.available,
    )
