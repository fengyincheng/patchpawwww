export class ReviewStale extends Error {
  constructor(readonly expectedHead: string, readonly actualHead: string, readonly changeRequestState: string) {
    super('Change request is closed or head changed before review publication');
    this.name = 'ReviewStale';
  }

  get prState() { return this.changeRequestState; }
}
